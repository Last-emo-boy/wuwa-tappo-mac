import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegionProfile } from './regions.mjs';
import { installerMirrorAssetName, installerMirrorUrl, pinnedInstallerCache, verifyInstaller } from './sync-upstream.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function publishPinnedInstaller({ projectRoot = root, profile = getRegionProfile(), environment = process.env, execute = execFileSync } = {}) {
  const lock = JSON.parse(await readFile(path.join(projectRoot, profile.upstreamLock), 'utf8'));
  const url = installerMirrorUrl(lock, profile, {
    ...environment,
    WUWA_INSTALLER_MIRROR_BASE: `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/releases/download/upstream-resources`,
  });
  const name = installerMirrorAssetName(lock, profile);
  const source = pinnedInstallerCache(lock, projectRoot, profile).path;
  verifyInstaller(await readFile(source), lock, profile);
  const api = ['api', '--include', '--hostname', 'github.com', `repos/${environment.GITHUB_REPOSITORY}/releases/tags/upstream-resources`];
  const readRelease = () => {
    const response = execute('gh', api, { encoding: 'utf8' });
    const separator = String(response).match(/\r?\n\r?\n/);
    if (!separator) throw new Error('GitHub Release API did not return HTTP response headers');
    return JSON.parse(String(response).slice(separator.index + separator[0].length));
  };
  let release;
  try { release = readRelease(); }
  catch (error) {
    if (!/^HTTP\/\S+ 404\b/.test(String(error.stdout))) throw error;
    if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA)) throw new Error('GITHUB_SHA is required when creating the upstream-resources release');
    try {
      execute('gh', ['release', 'create', 'upstream-resources', '--repo', `github.com/${environment.GITHUB_REPOSITORY}`, '--target', environment.GITHUB_SHA, '--prerelease', '--latest=false', '--title', '官方资源构建镜像', '--notes', '按官方资源锁校验的原始安装包，仅供本仓库构建使用。Mac 应用请从 Mac 版本 Release 下载。'], { stdio: 'pipe', encoding: 'utf8' });
    } catch (createError) {
      // The two regional jobs can both observe the first-run 404.
      const reason = String(createError.stderr);
      if (/HTTP (401|403)\b/.test(reason) || !/already_exists|already exists/.test(reason)) throw createError;
    }
    release = readRelease();
  }
  const find = () => release.assets.find(asset => asset.name === name);
  const validateAsset = asset => {
    if (!asset || asset.size !== lock.installer.size || asset.digest !== `sha256:${lock.installer.sha256}`) throw new Error(`GitHub 构建源镜像与官方锁不一致：${name}`);
  };
  const existing = find();
  if (existing) {
    validateAsset(existing);
    return { url, reused: true };
  }
  const directory = path.join(projectRoot, '.work/installer-mirror');
  await mkdir(directory, { recursive: true });
  const upload = path.join(directory, name);
  await copyFile(source, upload);
  execute('gh', ['release', 'upload', 'upstream-resources', upload, '--repo', `github.com/${environment.GITHUB_REPOSITORY}`], { stdio: 'inherit' });
  release = readRelease();
  validateAsset(find());
  return { url, reused: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishPinnedInstaller().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
