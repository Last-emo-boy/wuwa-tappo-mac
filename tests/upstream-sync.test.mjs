import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assetsOrigin, compareUpstream, configUrl, discoverUpstream, fetchOfficial, officialAssetUrl, parseManifest, parseOptions, syncUpstream, validateLock, verifyInstaller } from '../scripts/sync-upstream.mjs';
import { getRegionProfile } from '../scripts/regions.mjs';

const url = `${assetsOrigin}/app/release/WuwaTappo-cn_1.0.0_x64-setup.exe`;
const manifestUrl = `${assetsOrigin}/app/version-json/latest.json?t=1`;
const signature = 'fixture-public-installer-signature';
const manifest = { version: '1.0.0', platforms: { 'windows-x86_64': { url, signature } } };
const bytes = Buffer.from('fixture installer');
const lock = () => ({ ...parseManifest(manifest, manifestUrl), installer: { url, signature,
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });

test('accepts only exact official HTTPS origin and CN versioned installers', () => {
  assert.equal(officialAssetUrl(url), url);
  assert.equal(parseManifest(manifest, manifestUrl).region, 'CN');
  for (const invalid of [
    url.replace('https:', 'http:'), url.replace('kurogames-global.com', 'example.com'),
    url.replace('https://', 'https://user:password@'), `${url}#secret`,
    url.replace('.com/', '.com:8443/'),
  ]) assert.throws(() => officialAssetUrl(invalid));
  assert.throws(() => parseManifest({ ...manifest, platforms: { 'windows-x86_64': { url: url.replace('-cn_', '-global_') } } }, manifestUrl), /国服/);
  assert.throws(() => parseManifest({ ...manifest, version: '1.1.0' }, manifestUrl), /版本一致/);
  assert.throws(() => parseManifest({ ...manifest, version: '../1.0.0' }, manifestUrl), /版本号/);
  assert.throws(() => parseManifest({ ...manifest, platforms: {} }, manifestUrl));
  assert.throws(() => parseManifest({ ...manifest, platforms: { 'windows-x86_64': { url, signature: '' } } }, manifestUrl), /签名/);
});

test('lock requires CN identity, installer size and content digest', () => {
  assert.equal(validateLock(lock()).version, '1.0.0');
  for (const invalid of [
    { ...lock(), region: 'GLOBAL' }, { ...lock(), schemaVersion: 2 },
    { ...lock(), installer: { ...lock().installer, size: 0 } },
    { ...lock(), installer: { ...lock().installer, size: 1.5 } },
    { ...lock(), installer: { ...lock().installer, sha256: 'invalid' } },
  ]) assert.throws(() => validateLock(invalid));
});

test('installer validation detects truncation and same-size tampering', () => {
  assert.deepEqual(verifyInstaller(bytes, lock()), { size: bytes.length, sha256: lock().installer.sha256 });
  assert.throws(() => verifyInstaller(bytes.subarray(1), lock()), /大小不匹配/);
  assert.throws(() => verifyInstaller(Buffer.alloc(bytes.length), lock()), /SHA-256 不匹配/);
});

test('changed detection covers newer versions and republished installer URLs', () => {
  assert.deepEqual(compareUpstream(lock(), parseManifest(manifest, manifestUrl)), {
    region: 'CN', regionId: 'cn', changed: false, currentVersion: '1.0.0', latestVersion: '1.0.0', installerUrl: url,
  });
  const republished = parseManifest({ ...manifest, platforms: { 'windows-x86_64': { url: url.replace('/release/', '/new-release/'), signature } } }, manifestUrl);
  assert.equal(compareUpstream(lock(), republished).changed, true);
  const signedAgain = parseManifest({ ...manifest, platforms: { 'windows-x86_64': { url, signature: 'changed-signature' } } }, manifestUrl);
  assert.equal(compareUpstream(lock(), signedAgain).changed, true);
  const next = parseManifest({ version: '1.1.0', platforms: { 'windows-x86_64': { url: url.replace('1.0.0', '1.1.0'), signature } } }, manifestUrl);
  assert.equal(compareUpstream(lock(), next).latestVersion, '1.1.0');
  assert.equal(compareUpstream(lock(), next).changed, true);
});

test('discovery follows config, pointer, and manifest with redirects disabled', async () => {
  const requests = [];
  const responses = [{ code: 0, data: { assets_host: assetsOrigin } }, { url: manifestUrl }, manifest];
  const fetched = await discoverUpstream(async (input, options) => {
    requests.push(input);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => responses.shift() };
  });
  assert.deepEqual(requests, [configUrl, `${assetsOrigin}/app/json-host/latest_host.json`, manifestUrl]);
  assert.equal(fetched.installer.url, url);
});

test('discovery rejects failures and untrusted manifest redirects before fetching them', async () => {
  await assert.rejects(discoverUpstream(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(discoverUpstream(async () => ({ ok: true, json: async () => ({ code: 1 }) })), /配置无效/);
  await assert.rejects(discoverUpstream(async () => ({ ok: true, json: async () => ({ code: 0, data: { assets_host: 'https://example.com' } }) })), /官方/);
  const responses = [{ code: 0, data: { assets_host: assetsOrigin } }, { url: 'https://example.com/manifest.json' }];
  let count = 0;
  await assert.rejects(discoverUpstream(async () => { count += 1; return { ok: true, json: async () => responses.shift() }; }), /官方/);
  assert.equal(count, 2);
});

test('official requests retry transient connection failures with bounded backoff and preserve secure options', async () => {
  const sleeps = [];
  let count = 0;
  const result = await fetchOfficial(configUrl, {
    stage: 'CN 活动配置', sleep: async milliseconds => sleeps.push(milliseconds),
    fetcher: async (input, options) => {
      assert.equal(input, configUrl);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (++count < 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
      return { ok: true, json: async () => ({ code: 0 }) };
    },
  });
  assert.deepEqual(result, { code: 0 });
  assert.equal(count, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test('exhausted transient failures identify the request stage, URL, attempt and root cause', async () => {
  const rootCause = Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  let count = 0;
  await assert.rejects(fetchOfficial(manifestUrl, {
    stage: 'CN 版本清单', sleep: async () => {},
    fetcher: async () => { count += 1; throw new TypeError('fetch failed', { cause: rootCause }); },
  }), error => {
    assert.ok(error.message.includes('CN 版本清单'));
    assert.ok(error.message.includes(manifestUrl));
    assert.ok(error.message.includes('第 3 次请求'));
    assert.ok(error.message.includes('UND_ERR_CONNECT_TIMEOUT'));
    assert.equal(error.cause.cause, rootCause);
    return true;
  });
  assert.equal(count, 3);
});

test('temporary HTTP failure retries but forbidden and redirect responses do not', async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 301, 403, 404]) {
    let count = 0, cancelled = 0;
    await assert.rejects(fetchOfficial(configUrl, {
      sleep: async () => {},
      fetcher: async () => { count += 1; return { ok: false, status, body: { cancel: async () => { cancelled += 1; } } }; },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(count, [301, 403, 404].includes(status) ? 1 : 3);
    assert.equal(cancelled, count);
  }
});

test('certificate and redirect errors fail once without bypassing security or accepting invalid JSON', async () => {
  for (const cause of [Object.assign(new Error('untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }), new Error('unexpected redirect'), new SyntaxError('invalid JSON')]) {
    let count = 0;
    await assert.rejects(fetchOfficial(configUrl, {
      fetcher: async () => { count += 1; throw new TypeError('fetch failed', { cause }); },
      sleep: async () => assert.fail('permanent errors must not wait for a retry'),
    }), error => error.cause.cause === cause);
    assert.equal(count, 1);
  }
});

test('an interrupted installer body is retried before handing bytes to integrity validation', async () => {
  let count = 0;
  const result = await fetchOfficial(url, {
    timeout: 300_000, sleep: async () => {},
    read: async response => Buffer.from(await response.arrayBuffer()),
    fetcher: async () => {
      const attempt = ++count;
      return { ok: true, arrayBuffer: async () => {
        if (attempt === 1) throw Object.assign(new Error('body interrupted'), { code: 'UND_ERR_SOCKET' });
        return bytes;
      } };
    },
  });
  assert.equal(count, 2);
  assert.deepEqual(verifyInstaller(result, lock()), { size: bytes.length, sha256: lock().installer.sha256 });
});

test('CLI keeps read-only check separate from downloads and extracts', () => {
  assert.deepEqual(parseOptions(['--check']), { check: true });
  assert.deepEqual(parseOptions(['--installer', '/tmp/source.exe', '--sevenzip', '/tmp/7zz']), {
    installer: '/tmp/source.exe', sevenzip: '/tmp/7zz',
  });
  assert.deepEqual(parseOptions(['--update-lock']), { updateLock: true });
  for (const args of [['--invalid'], ['--installer'], ['--sevenzip', '--check'], ['--check', '--update-lock'], ['--check', '--installer', '/tmp/source.exe'], ['--update-lock', '--installer', '/tmp/source.exe']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('checked-in resource lock remains a valid pinned CN artifact', async () => {
  const current = JSON.parse(await readFile(new URL('../upstream-cn.json', import.meta.url), 'utf8'));
  assert.equal(validateLock(current).region, 'CN');
});

const globalProfile = getRegionProfile('global');
const globalUrl = `${globalProfile.assetsOrigin}/app/release/WuwaTappo-global_1.0.1_x64-setup.exe`;
const globalManifestUrl = `${globalProfile.assetsOrigin}/app/version-json/latest-global.json?t=1`;
const globalManifest = { version: '1.0.1', platforms: { 'windows-x86_64': { url: globalUrl, signature } } };
const globalLock = () => ({ ...parseManifest(globalManifest, globalManifestUrl, globalProfile), installer: {
  url: globalUrl, signature, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
} });

test('CN and Global manifests cannot cross official origins or installer names', () => {
  assert.equal(parseManifest(globalManifest, globalManifestUrl, globalProfile).region, 'GLOBAL');
  assert.throws(() => parseManifest(globalManifest, globalManifestUrl));
  assert.throws(() => parseManifest(manifest, manifestUrl, globalProfile));
  const wrongName = { ...globalManifest, platforms: { 'windows-x86_64': { url: globalUrl.replace('-global_', '-cn_'), signature } } };
  assert.throws(() => parseManifest(wrongName, globalManifestUrl, globalProfile), /国际服安装包/);
  assert.throws(() => officialAssetUrl(url, globalProfile));
  assert.throws(() => officialAssetUrl(globalUrl));
});

test('both regional locks validate content only under their own profile', () => {
  assert.equal(validateLock(globalLock(), globalProfile).region, 'GLOBAL');
  assert.deepEqual(verifyInstaller(bytes, globalLock(), globalProfile), { size: bytes.length, sha256: globalLock().installer.sha256 });
  assert.throws(() => validateLock(globalLock()));
  assert.throws(() => validateLock(lock(), globalProfile));
  assert.throws(() => verifyInstaller(bytes, globalLock()));
  assert.throws(() => compareUpstream(lock(), globalLock()), /不同服务器/);
});

test('Global discovery uses its own activity host and global update pointer', async () => {
  const requests = [];
  const responses = [{ code: 0, data: { assets_host: globalProfile.assetsOrigin } }, { url: globalManifestUrl }, globalManifest];
  const latest = await discoverUpstream(async (input, options) => {
    requests.push(input);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => responses.shift() };
  }, globalProfile);
  assert.deepEqual(requests, [globalProfile.configUrl, `${globalProfile.assetsOrigin}/app/json-host/latest-global_host.json`, globalManifestUrl]);
  assert.equal(latest.region, 'GLOBAL');
  assert.equal(compareUpstream(globalLock(), latest).regionId, 'global');
});

test('WUWA_REGION selects a separate lock while check remains read-only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-upstream-region-'));
  const previousRegion = process.env.WUWA_REGION;
  const previousFetch = globalThis.fetch;
  try {
    await writeFile(path.join(directory, 'upstream-cn.json'), JSON.stringify(lock()));
    await writeFile(path.join(directory, 'upstream-global.json'), JSON.stringify(globalLock()));
    const before = await readFile(path.join(directory, 'upstream-global.json'), 'utf8');
    process.env.WUWA_REGION = 'global';
    const responses = [{ code: 0, data: { assets_host: globalProfile.assetsOrigin } }, { url: globalManifestUrl }, globalManifest];
    globalThis.fetch = async () => ({ ok: true, json: async () => responses.shift() });
    const result = await syncUpstream({ check: true }, directory);
    assert.equal(result.region, 'GLOBAL');
    assert.equal(result.regionId, 'global');
    assert.equal(result.changed, false);
    assert.equal(result.currentVersion, '1.0.1');
    assert.equal(await readFile(path.join(directory, 'upstream-global.json'), 'utf8'), before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegion === undefined) delete process.env.WUWA_REGION;
    else process.env.WUWA_REGION = previousRegion;
    await rm(directory, { recursive: true, force: true });
  }
});

test('checked-in Global resource lock remains separate from CN', async () => {
  const current = JSON.parse(await readFile(new URL('../upstream-global.json', import.meta.url), 'utf8'));
  assert.equal(validateLock(current, globalProfile).region, 'GLOBAL');
});
