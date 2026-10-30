import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getRegionProfile } from './regions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cn = getRegionProfile('cn');
export const configUrl = cn.configUrl;
export const assetsOrigin = cn.assetsOrigin;

export function officialAssetUrl(value, profile = cn) {
  const url = new URL(value);
  if (url.origin !== profile.assetsOrigin || url.username || url.password || url.hash) {
    throw new Error(`资源地址必须来自${profile.region === 'CN' ? '国服' : '国际服'}官方 HTTPS 域名。`);
  }
  return url.href;
}

export function parseManifest(manifest, manifestUrl, profile = cn) {
  officialAssetUrl(manifestUrl, profile);
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('官方版本号无效。');
  }
  const url = officialAssetUrl(manifest?.platforms?.['windows-x86_64']?.url, profile);
  if (new URL(url).pathname.split('/').at(-1) !== `WuwaTappo-${profile.id}_${version}_x64-setup.exe`) {
    throw new Error(`官方清单必须提供与版本一致的${profile.region === 'CN' ? '国服' : '国际服'}安装包。`);
  }
  const signature = manifest.platforms['windows-x86_64'].signature;
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('官方清单缺少安装包签名。');
  return { schemaVersion: 1, region: profile.region, version, manifestUrl, installer: { url, signature } };
}

export function validateLock(lock, profile = cn) {
  if (lock?.schemaVersion !== 1 || lock.region !== profile.region) throw new Error(`资源锁必须是 schemaVersion 1 的 ${profile.region} 配置。`);
  parseManifest({ version: lock.version, platforms: { 'windows-x86_64': lock.installer } }, lock.manifestUrl, profile);
  if (!/^[a-f0-9]{64}$/.test(lock.installer.sha256) || !Number.isSafeInteger(lock.installer.size) || lock.installer.size <= 0) {
    throw new Error('资源锁缺少有效的 SHA-256 或文件大小。');
  }
  return lock;
}

export function verifyInstaller(bytes, lock, profile = cn) {
  validateLock(lock, profile);
  if (bytes.length !== lock.installer.size) throw new Error(`${profile.region} 安装包大小不匹配，请重新下载锁定版本。`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== lock.installer.sha256) throw new Error(`${profile.region} 安装包 SHA-256 不匹配，已停止构建。`);
  return { sha256, size: bytes.length };
}

export function compareUpstream(current, latest) {
  if (current.region !== latest.region) throw new Error('不能比较不同服务器的资源锁。');
  return {
    region: latest.region,
    regionId: latest.region.toLowerCase(),
    changed: current.version !== latest.version || current.installer.url !== latest.installer.url || current.installer.signature !== latest.installer.signature,
    currentVersion: current.version,
    latestVersion: latest.version,
    installerUrl: latest.installer.url,
  };
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function errorDetails(error) {
  const details = [];
  for (let cause = error; cause instanceof Error && !details.includes(cause); cause = cause.cause) details.push(cause);
  return details;
}

export async function fetchOfficial(url, { fetcher = fetch, read = response => response.json(), stage, timeout = 30_000, sleep = delay } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        await response.body?.cancel();
        throw error;
      }
      return await read(response);
    } catch (error) {
      const causes = errorDetails(error);
      const transient = retryableStatuses.has(error.status) || causes.some(cause => retryableCodes.has(cause.code) || cause.name === 'TimeoutError');
      if (transient && attempt < 3) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      const reason = causes.map(cause => `${cause.message}${cause.code ? ` (${cause.code})` : ''}`).join(' → ') || String(error);
      throw new Error(`${stage || '读取官方资源'}失败：${url}；第 ${attempt} 次请求：${reason}`, { cause: error });
    }
  }
}

export async function discoverUpstream(fetcher = fetch, profile = cn) {
  const config = await fetchOfficial(profile.configUrl, { fetcher, stage: `${profile.region} 活动配置` });
  if (config.code !== 0 || typeof config.data?.assets_host !== 'string') throw new Error(`${profile.region} 活动配置无效。`);
  const host = officialAssetUrl(config.data.assets_host, profile);
  if (new URL(host).pathname !== '/') throw new Error(`${profile.region} 资源根地址无效。`);
  const pointer = await fetchOfficial(new URL(`/app/json-host/${profile.updaterHostFile}`, host).href, { fetcher, stage: `${profile.region} 版本指针` });
  const manifestUrl = officialAssetUrl(pointer.url, profile);
  return parseManifest(await fetchOfficial(manifestUrl, { fetcher, stage: `${profile.region} 版本清单` }), manifestUrl, profile);
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

function installerCachePath(url, work, profile) {
  const parts = new URL(officialAssetUrl(url, profile)).pathname.split('/').filter(Boolean).map(encodeURIComponent);
  return path.join(work, 'installers', ...parts);
}

export function pinnedInstallerCache(lock, projectRoot = root, profile = cn) {
  validateLock(lock, profile);
  return {
    key: `official-installer-v1-${profile.id}-${lock.installer.size}-${lock.installer.sha256}-${encodeURIComponent(new URL(lock.installer.url).pathname)}`,
    path: installerCachePath(lock.installer.url, path.join(projectRoot, '.work'), profile),
  };
}

export function installerMirrorAssetName(lock, profile = cn) {
  validateLock(lock, profile);
  return `${lock.installer.sha256}-${new URL(lock.installer.url).pathname.split('/').at(-1)}`;
}

export function installerMirrorUrl(lock, profile = cn, environment = process.env) {
  const filename = installerMirrorAssetName(lock, profile);
  const repository = environment.GITHUB_REPOSITORY;
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_SERVER_URL !== 'https://github.com' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
    throw new Error('安装包镜像仅支持明确配置的本仓库 GitHub Actions 构建。');
  }
  const expected = `https://github.com/${repository}/releases/download/upstream-resources`;
  const base = new URL(environment.WUWA_INSTALLER_MIRROR_BASE);
  if (base.href.replace(/\/$/, '') !== expected || base.username || base.password || base.search || base.hash) {
    throw new Error('安装包镜像必须是本仓库固定的 upstream-resources GitHub Release。');
  }
  return `${expected}/${encodeURIComponent(filename)}`;
}

function mirrorEligibleFailure(error) {
  const causes = errorDetails(error);
  if (causes.some(cause => (cause.status >= 400 && cause.status < 500) || /CERT|^ERR_TLS_|^UNABLE_TO_VERIFY_LEAF_SIGNATURE$/.test(cause.code || ''))) return false;
  return causes.some(cause => retryableStatuses.has(cause.status) || retryableCodes.has(cause.code) || cause.name === 'TimeoutError');
}

async function fetchInstallerMirror(url, fetcher) {
  try {
    let response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      const asset = location ? new URL(location, url) : null;
      if (!asset || asset.origin !== 'https://release-assets.githubusercontent.com' || asset.username || asset.password || asset.hash) {
        throw Object.assign(new Error('GitHub Release redirect must target its HTTPS asset host'), { code: 'UNTRUSTED_MIRROR_REDIRECT' });
      }
      await response.body?.cancel();
      response = await fetcher(asset.href, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
    }
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // Signed CDN query parameters must not appear in CI logs.
    const reason = errorDetails(error).map(cause => cause.status ? `HTTP ${cause.status}` : cause.code || cause.name).join(' → ');
    throw new Error(`GitHub 安装包镜像下载失败：${url}；${reason}`, { cause: error });
  }
}

export async function downloadInstaller(lock, { profile = cn, updateLock = false, environment = process.env, fetcher = fetch, sleep = delay, log = console.warn } = {}) {
  if (updateLock) parseManifest({ version: lock.version, platforms: { 'windows-x86_64': lock.installer } }, lock.manifestUrl, profile);
  else validateLock(lock, profile);
  let bytes;
  try {
    bytes = await fetchOfficial(lock.installer.url, {
      stage: `${profile.region} 安装包下载`, timeout: 300_000, fetcher, sleep,
      read: async response => Buffer.from(await response.arrayBuffer()),
    });
  } catch (error) {
    if (updateLock || !environment.WUWA_INSTALLER_MIRROR_BASE || !mirrorEligibleFailure(error)) throw error;
    const mirror = installerMirrorUrl(lock, profile, environment);
    log(`[${profile.region}] 官方安装包请求耗尽：${error.message}\n[${profile.region}] 使用显式构建源镜像（仍校验官方锁定大小及 SHA-256）：${mirror}`);
    bytes = await fetchInstallerMirror(mirror, fetcher);
  }
  if (lock.installer.sha256) verifyInstaller(bytes, lock, profile);
  return bytes;
}

async function installerBytes(lock, options, work, profile) {
  if (options.installer) return { filename: path.resolve(options.installer), bytes: await readFile(options.installer) };
  const filename = installerCachePath(lock.installer.url, work, profile);
  if (!options.updateLock && await exists(filename)) return { filename, bytes: await readFile(filename) };
  const bytes = await downloadInstaller(lock, { profile, updateLock: options.updateLock });
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(`${filename}.download`, bytes);
  await rename(`${filename}.download`, filename);
  return { filename, bytes };
}

export async function syncUpstream(options = {}, projectRoot = root) {
  const profile = getRegionProfile();
  const lockPath = path.join(projectRoot, profile.upstreamLock);
  const current = validateLock(JSON.parse(await readFile(lockPath, 'utf8')), profile);
  const latest = options.check || options.updateLock ? await discoverUpstream(fetch, profile) : current;
  const comparison = compareUpstream(current, latest);
  if (options.check) return comparison;
  const target = options.updateLock ? latest : current;
  const sevenzip = findSevenZip(options.sevenzip);
  const work = path.join(projectRoot, '.work');
  await mkdir(work, { recursive: true });
  const { filename, bytes } = await installerBytes(target, options, work, profile);
  if (options.updateLock) {
    target.installer = { ...target.installer, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    // A same-version download must not silently replace a previously pinned artifact.
    if (!comparison.changed) verifyInstaller(bytes, current, profile);
  }
  verifyInstaller(bytes, target, profile);
  const staging = await mkdtemp(path.join(work, `upstream-${profile.id}-`));
  const output = path.join(staging, 'frontend');
  const frontend = path.join(projectRoot, profile.frontendDir);
  const backup = path.join(staging, 'previous-frontend');
  try {
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/extract-assets.mjs'),
      '--installer', filename, '--sevenzip', sevenzip, '--output', output], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${profile.region} 资源提取失败：${result.stderr.trim() || result.stdout.trim()}`);
    const extracted = JSON.parse(result.stdout);
    const hadFrontend = await exists(frontend);
    if (hadFrontend) await rename(frontend, backup);
    try { await rename(output, frontend); }
    catch (error) { if (hadFrontend) await rename(backup, frontend); throw error; }
    if (options.updateLock) await writeFile(lockPath, `${JSON.stringify(target, null, 2)}\n`);
    await writeFile(path.join(work, profile.id === 'cn' ? 'upstream-extraction.json' : `upstream-${profile.id}-extraction.json`), result.stdout);
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
