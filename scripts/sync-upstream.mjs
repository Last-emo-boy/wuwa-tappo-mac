import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const configUrl = 'https://api-mc-wuwatappo.kurogames-global.com/api/common/activity-config';
export const assetsOrigin = 'https://mc-wuwatappo.kurogames-global.com';

export function officialAssetUrl(value) {
  const url = new URL(value);
  if (url.origin !== assetsOrigin || url.username || url.password || url.hash) {
    throw new Error('资源地址必须来自国服官方 HTTPS 域名。');
  }
  return url.href;
}

export function parseManifest(manifest, manifestUrl) {
  officialAssetUrl(manifestUrl);
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('官方版本号无效。');
  }
  const url = officialAssetUrl(manifest?.platforms?.['windows-x86_64']?.url);
  if (new URL(url).pathname.split('/').at(-1) !== `WuwaTappo-cn_${version}_x64-setup.exe`) {
    throw new Error('官方清单必须提供与版本一致的国服安装包。');
  }
  const signature = manifest.platforms['windows-x86_64'].signature;
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('官方清单缺少安装包签名。');
  return { schemaVersion: 1, region: 'CN', version, manifestUrl, installer: { url, signature } };
}

export function validateLock(lock) {
  if (lock?.schemaVersion !== 1 || lock.region !== 'CN') throw new Error('资源锁必须是 schemaVersion 1 的国服配置。');
  parseManifest({ version: lock.version, platforms: { 'windows-x86_64': lock.installer } }, lock.manifestUrl);
  if (!/^[a-f0-9]{64}$/.test(lock.installer.sha256) || !Number.isSafeInteger(lock.installer.size) || lock.installer.size <= 0) {
    throw new Error('资源锁缺少有效的 SHA-256 或文件大小。');
  }
  return lock;
}

export function verifyInstaller(bytes, lock) {
  validateLock(lock);
  if (bytes.length !== lock.installer.size) throw new Error('国服安装包大小不匹配，请重新下载锁定版本。');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== lock.installer.sha256) throw new Error('国服安装包 SHA-256 不匹配，已停止构建。');
  return { sha256, size: bytes.length };
}

export function compareUpstream(current, latest) {
  return {
    changed: current.version !== latest.version || current.installer.url !== latest.installer.url || current.installer.signature !== latest.installer.signature,
    currentVersion: current.version,
    latestVersion: latest.version,
    installerUrl: latest.installer.url,
  };
}

async function fetchJson(url, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`读取官方配置失败：HTTP ${response.status}`);
  return response.json();
}

export async function discoverUpstream(fetcher = fetch) {
  const config = await fetchJson(configUrl, fetcher);
  if (config.code !== 0 || typeof config.data?.assets_host !== 'string') throw new Error('国服活动配置无效。');
  const host = officialAssetUrl(config.data.assets_host);
  if (new URL(host).pathname !== '/') throw new Error('国服资源根地址无效。');
  const pointer = await fetchJson(new URL('/app/json-host/latest_host.json', host).href, fetcher);
  const manifestUrl = officialAssetUrl(pointer.url);
  return parseManifest(await fetchJson(manifestUrl, fetcher), manifestUrl);
}

async function exists(filename) {
  try { await access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function findSevenZip(explicit, environment = process.env) {
  for (const candidate of [explicit, environment.SEVENZIP, '7zz', '7z'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['i'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (!probe.error && probe.status === 0) return candidate;
    if (candidate === explicit || candidate === environment.SEVENZIP) throw new Error(`无法运行指定的 7-Zip：${candidate}`);
  }
  throw new Error('未找到 7-Zip。请先安装 7zip，或通过 --sevenzip /路径/7zz 指定。');
}

async function installerBytes(lock, options, work) {
  if (options.installer) return { filename: path.resolve(options.installer), bytes: await readFile(options.installer) };
  const parts = new URL(lock.installer.url).pathname.split('/').filter(Boolean).map(encodeURIComponent);
  const filename = path.join(work, 'installers', ...parts);
  if (!options.updateLock && await exists(filename)) return { filename, bytes: await readFile(filename) };
  const response = await fetch(lock.installer.url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载国服安装包失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (lock.installer.sha256) verifyInstaller(bytes, lock);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(`${filename}.download`, bytes);
  await rename(`${filename}.download`, filename);
  return { filename, bytes };
}

export async function syncUpstream(options = {}, projectRoot = root) {
  const lockPath = path.join(projectRoot, 'upstream-cn.json');
  const current = validateLock(JSON.parse(await readFile(lockPath, 'utf8')));
  const latest = options.check || options.updateLock ? await discoverUpstream() : current;
  const comparison = compareUpstream(current, latest);
  if (options.check) return comparison;
  const target = options.updateLock ? latest : current;
  const sevenzip = findSevenZip(options.sevenzip);
  const work = path.join(projectRoot, '.work');
  await mkdir(work, { recursive: true });
  const { filename, bytes } = await installerBytes(target, options, work);
  if (options.updateLock) {
    target.installer = { ...target.installer, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    // A same-version download must not silently replace a previously pinned artifact.
    if (!comparison.changed) verifyInstaller(bytes, current);
  }
  verifyInstaller(bytes, target);
  const staging = await mkdtemp(path.join(work, 'upstream-'));
  const output = path.join(staging, 'frontend');
  const frontend = path.join(projectRoot, 'frontend');
  const backup = path.join(staging, 'previous-frontend');
  try {
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/extract-assets.mjs'),
      '--installer', filename, '--sevenzip', sevenzip, '--output', output], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`国服资源提取失败：${result.stderr.trim() || result.stdout.trim()}`);
    const extracted = JSON.parse(result.stdout);
    const hadFrontend = await exists(frontend);
    if (hadFrontend) await rename(frontend, backup);
    try { await rename(output, frontend); }
    catch (error) { if (hadFrontend) await rename(backup, frontend); throw error; }
    if (options.updateLock) await writeFile(lockPath, `${JSON.stringify(target, null, 2)}\n`);
    await writeFile(path.join(work, 'upstream-extraction.json'), result.stdout);
    return { ...comparison, version: target.version, region: target.region, files: extracted.count, staticReferences: extracted.staticReferences };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--update-lock') options.updateLock = true;
    else if (arg === '--installer' || arg === '--sevenzip') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要路径。`);
      options[arg.slice(2)] = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (options.check && (options.updateLock || options.installer || options.sevenzip)) throw new Error('--check 只检查版本，不能与下载或提取参数同时使用。');
  if (options.updateLock && options.installer) throw new Error('--update-lock 必须从官方地址下载，不能使用本地安装包。');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => syncUpstream(parseOptions(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
