import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRegionProfile } from '../scripts/regions.mjs';
import { downloadInstaller, installerMirrorAssetName, installerMirrorUrl, pinnedInstallerCache } from '../scripts/sync-upstream.mjs';
import { publishPinnedInstaller } from '../scripts/installer-mirror.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bytes = Buffer.from('official installer public fixture');
const environment = {
  GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo',
  WUWA_INSTALLER_MIRROR_BASE: 'https://github.com/owner/repo/releases/download/upstream-resources',
};
function fixtureLock(region = 'cn') {
  const profile = getRegionProfile(region);
  return {
    schemaVersion: 1, region: profile.region, version: '1.0.2', manifestUrl: `${profile.assetsOrigin}/app/version-json/latest.json`,
    installer: { url: `${profile.assetsOrigin}/app/release/WuwaTappo-${region}_1.0.2_x64-setup.exe`, signature: 'public-signature', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}
const timeout = () => new TypeError('fetch failed', { cause: Object.assign(new Error('official connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
const response = payload => ({ ok: true, status: 200, arrayBuffer: async () => payload });
const releaseResponse = assets => `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ assets })}`;
const downloadOptions = { environment, sleep: async () => {}, log: () => {} };

test('mirror URLs are immutable pin-prefixed assets in this exact GitHub Actions repository release', () => {
  for (const region of ['cn', 'global']) {
    const profile = getRegionProfile(region), lock = fixtureLock(region);
    const name = `${lock.installer.sha256}-WuwaTappo-${region}_1.0.2_x64-setup.exe`;
    assert.equal(installerMirrorAssetName(lock, profile), name);
    assert.equal(installerMirrorUrl(lock, profile, environment), `${environment.WUWA_INSTALLER_MIRROR_BASE}/${name}`);
    const republished = { ...lock, installer: { ...lock.installer, sha256: '0'.repeat(64) } };
    assert.notEqual(installerMirrorUrl(republished, profile, environment), installerMirrorUrl(lock, profile, environment));
    for (const base of ['https://github.com/other/repo/releases/download/upstream-resources', 'http://github.com/owner/repo/releases/download/upstream-resources', 'https://github.com.evil.test/owner/repo/releases/download/upstream-resources', `${environment.WUWA_INSTALLER_MIRROR_BASE}?token=secret`, `${environment.WUWA_INSTALLER_MIRROR_BASE}#secret`, 'https://user:password@github.com/owner/repo/releases/download/upstream-resources', 'https://github.com/owner/repo/releases/download/v1.0.2-mac.1']) {
      assert.throws(() => installerMirrorUrl(lock, profile, { ...environment, WUWA_INSTALLER_MIRROR_BASE: base }));
    }
    assert.throws(() => installerMirrorUrl(lock, profile, { ...environment, GITHUB_ACTIONS: 'false' }));
    assert.throws(() => installerMirrorUrl(lock, profile, { ...environment, GITHUB_SERVER_URL: 'https://example.com' }));
    assert.throws(() => installerMirrorUrl({ ...lock, installer: { ...lock.installer, url: lock.installer.url.replace('.exe', '-other.exe') } }, profile, environment));
  }
});

test('only exhausted recoverable official downloads use the explicit mirror and verify the GitHub CDN body', async () => {
  for (const region of ['cn', 'global']) {
    const profile = getRegionProfile(region), lock = fixtureLock(region), requests = [], logs = [], sleeps = [];
    const mirror = installerMirrorUrl(lock, profile, environment);
    const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/file?signature=private-cdn-query';
    const fetched = await downloadInstaller(lock, { ...downloadOptions, profile, log: message => logs.push(message), sleep: async milliseconds => sleeps.push(milliseconds), fetcher: async (url, options) => {
      requests.push(url);
      if (url === lock.installer.url) { assert.equal(options.redirect, 'error'); throw timeout(); }
      if (url === mirror) { assert.equal(options.redirect, 'manual'); return { status: 302, headers: new Headers({ location: cdn }) }; }
      assert.equal(url, cdn);
      assert.equal(options.redirect, 'error');
      return response(bytes);
    } });
    assert.deepEqual(fetched, bytes);
    assert.deepEqual(requests, [lock.installer.url, lock.installer.url, lock.installer.url, mirror, cdn]);
    assert.deepEqual(sleeps, [250, 500]);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes(lock.installer.url));
    assert.ok(logs[0].includes(mirror));
    assert.ok(logs[0].includes('UND_ERR_CONNECT_TIMEOUT'));
    assert.ok(!logs[0].includes('private-cdn-query'));
  }
});

test('truncated or same-size tampered mirror content fails the official pin', async () => {
  const lock = fixtureLock();
  for (const payload of [bytes.subarray(1), Buffer.alloc(bytes.length)]) {
    await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => {
      if (url === lock.installer.url) throw timeout();
      return response(payload);
    } }), /大小不匹配|SHA-256 不匹配/);
  }
});

test('HTTP 4xx, certificates and successful-but-corrupt official responses never fall back', async () => {
  const lock = fixtureLock();
  for (const status of [401, 403, 404, 408, 429]) {
    const urls = [];
    await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => { urls.push(url); return { ok: false, status }; } }), new RegExp(`HTTP ${status}`));
    assert.ok(urls.every(url => url === lock.installer.url));
  }
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    const urls = [];
    await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => { urls.push(url); throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate failure'), { code }) }); } }), new RegExp(code));
    assert.deepEqual(urls, [lock.installer.url]);
  }
  const urls = [];
  await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => { urls.push(url); return response(Buffer.alloc(bytes.length)); } }), /SHA-256 不匹配/);
  assert.deepEqual(urls, [lock.installer.url]);
});

test('an absent mirror preserves legacy failure and official success does not access mirror', async () => {
  const lock = fixtureLock(), urls = [];
  await assert.rejects(downloadInstaller(lock, { ...downloadOptions, environment: {}, fetcher: async url => { urls.push(url); throw timeout(); } }), /第 3 次请求.*UND_ERR_CONNECT_TIMEOUT/);
  assert.deepEqual(urls, [lock.installer.url, lock.installer.url, lock.installer.url]);
  urls.length = 0;
  assert.deepEqual(await downloadInstaller(lock, { ...downloadOptions, fetcher: async url => { urls.push(url); return response(bytes); } }), bytes);
  assert.deepEqual(urls, [lock.installer.url]);
});

test('unlocked discovery or update cannot acquire its pin from the mirror', async () => {
  const lock = fixtureLock(), unpinned = { ...lock, installer: { url: lock.installer.url, signature: lock.installer.signature } };
  let count = 0;
  await assert.rejects(downloadInstaller(unpinned, { ...downloadOptions, fetcher: async () => { count += 1; return response(bytes); } }), /SHA-256/);
  assert.equal(count, 0);
  await assert.rejects(downloadInstaller({ ...unpinned, installer: { ...unpinned.installer, url: 'https://example.com/WuwaTappo-cn_1.0.2_x64-setup.exe' } }, { ...downloadOptions, updateLock: true, fetcher: async () => { count += 1; return response(bytes); } }), /官方 HTTPS/);
  assert.equal(count, 0);
  for (const candidate of [lock, unpinned]) {
    const urls = [];
    await assert.rejects(downloadInstaller(candidate, { ...downloadOptions, updateLock: true, fetcher: async url => { urls.push(url); throw timeout(); } }), /UND_ERR_CONNECT_TIMEOUT/);
    assert.deepEqual(urls, [lock.installer.url, lock.installer.url, lock.installer.url]);
  }
});

test('mirror redirects are restricted to one HTTPS GitHub asset hop and errors never print signed CDN query data', async () => {
  const lock = fixtureLock();
  for (const location of ['https://example.com/file?secret=query', 'http://release-assets.githubusercontent.com/file?secret=query', 'https://user:password@release-assets.githubusercontent.com/file?secret=query', 'https://release-assets.githubusercontent.com.evil.test/file?secret=query', 'https://github.com/other/repo/releases/download/upstream-resources/file?secret=query']) {
    let mirrorCalls = 0;
    await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => {
      if (url === lock.installer.url) throw timeout();
      mirrorCalls += 1;
      return { status: 302, headers: new Headers({ location }) };
    } }), error => error.message.includes('UNTRUSTED_MIRROR_REDIRECT') && !error.message.includes('secret=query'));
    assert.equal(mirrorCalls, 1);
  }
  const cdn = 'https://release-assets.githubusercontent.com/file?secret=query';
  await assert.rejects(downloadInstaller(lock, { ...downloadOptions, fetcher: async url => {
    if (url === lock.installer.url) throw timeout();
    if (url === cdn) throw new TypeError(`failure at ${cdn}`);
    return { status: 302, headers: new Headers({ location: cdn }) };
  } }), error => error.message.includes('GitHub 安装包镜像下载失败') && !error.message.includes('secret=query'));
});

test('mirror publishing verifies the local pin and reuses only matching immutable server digests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-mirror-publish-'));
  const lock = fixtureLock(), name = installerMirrorAssetName(lock);
  const matching = { name, size: bytes.length, digest: `sha256:${lock.installer.sha256}` };
  try {
    const source = pinnedInstallerCache(lock, directory).path;
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(path.join(directory, 'upstream-cn.json'), JSON.stringify(lock));
    for (const existing of [matching, { ...matching, size: bytes.length - 1 }, { ...matching, digest: 'sha256:wrong' }]) {
      const calls = [];
      const publish = () => publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment, execute: (command, args) => { calls.push([command, args]); return releaseResponse([existing]); } });
      if (existing === matching) assert.equal((await publish()).reused, true);
      else await assert.rejects(publish(), /官方锁不一致/);
      assert.equal(calls.length, 1);
    }
    const calls = [];
    let assets = [];
    const result = await publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment, execute: (command, args) => {
      calls.push([command, args]);
      assert.equal(command, 'gh');
      if (args[0] === 'api') return releaseResponse(assets);
      assert.deepEqual(args.slice(0, 3), ['release', 'upload', 'upstream-resources']);
      assert.equal(path.basename(args[3]), name);
      assert.ok(!args.includes('--clobber'));
      assets = [matching];
      return '';
    } });
    assert.equal(result.reused, false);
    assert.equal(calls.length, 3);
    assert.deepEqual(await readFile(path.join(directory, '.work/installer-mirror', name)), bytes);
    await writeFile(source, Buffer.alloc(bytes.length));
    await assert.rejects(publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment, execute: () => assert.fail('tampered source must fail before GitHub writes') }), /SHA-256 不匹配/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('first mirror publication creates only a genuinely missing non-latest prerelease and preserves permission failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-mirror-first-publish-'));
  const lock = fixtureLock(), name = installerMirrorAssetName(lock);
  const matching = { name, size: bytes.length, digest: `sha256:${lock.installer.sha256}` };
  const ci = { ...environment, GITHUB_SHA: 'a'.repeat(40) };
  const missing = status => Object.assign(new Error(`API HTTP ${status}`), { stdout: `HTTP/2.0 ${status} Failure\r\nContent-Type: application/json\r\n\r\n{"message":"Failure"}` });
  try {
    const source = pinnedInstallerCache(lock, directory).path;
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(path.join(directory, 'upstream-cn.json'), JSON.stringify(lock));
    for (const status of [401, 403, 500]) {
      const calls = [];
      await assert.rejects(publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment: ci, execute: (command, args) => { calls.push([command, args]); throw missing(status); } }), new RegExp(`HTTP ${status}`));
      assert.equal(calls.length, 1);
    }
    let created = false, assets = [];
    const calls = [];
    const result = await publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment: ci, execute: (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'api') { if (!created) throw missing(404); return releaseResponse(assets); }
      if (args[1] === 'create') {
        assert.equal(args[2], 'upstream-resources');
        assert.ok(args.includes('--prerelease'));
        assert.ok(args.includes('--latest=false'));
        assert.equal(args[args.indexOf('--target') + 1], ci.GITHUB_SHA);
        created = true;
      } else { assert.equal(args[1], 'upload'); assets = [matching]; }
      return '';
    } });
    assert.equal(result.reused, false);
    assert.equal(calls.length, 5);
    let deniedCalls = 0;
    await assert.rejects(publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment: ci, execute: (command, args) => {
      deniedCalls += 1;
      if (args[0] === 'api') throw missing(404);
      throw Object.assign(new Error('create forbidden'), { stderr: 'HTTP 403: Forbidden' });
    } }), /create forbidden/);
    assert.equal(deniedCalls, 2);
    let raced = false, racedCalls = 0;
    assert.equal((await publishPinnedInstaller({ projectRoot: directory, profile: getRegionProfile('cn'), environment: ci, execute: (command, args) => {
      racedCalls += 1;
      if (args[0] === 'api') { if (!raced) throw missing(404); return releaseResponse([matching]); }
      assert.equal(args[1], 'create');
      raced = true;
      throw Object.assign(new Error('release already exists'), { stderr: 'HTTP 422: Validation Failed; code: already_exists' });
    } })).reused, true);
    assert.equal(racedCalls, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only locked build workflow configures the explicit mirror and syncing publishes verified official inputs', async () => {
  const build = await readFile(path.join(root, '.github/workflows/build.yml'), 'utf8');
  const sync = await readFile(path.join(root, '.github/workflows/sync-upstream.yml'), 'utf8');
  assert.ok(build.includes('WUWA_INSTALLER_MIRROR_BASE: ${{ github.server_url }}/${{ github.repository }}/releases/download/upstream-resources'));
  assert.ok(!sync.includes('WUWA_INSTALLER_MIRROR_BASE:'));
  assert.match(sync, /Publish verified official installer as an immutable build input\n\s+id: mirror\n\s+if: always\(\) && !cancelled\(\) && steps\.extract\.outcome == 'success'\n\s+run: node scripts\/installer-mirror\.mjs/);
  assert.ok(sync.indexOf('Publish verified official installer as an immutable build input') > sync.indexOf('Keep upstream review evidence'));
  assert.ok(sync.indexOf('Publish verified official installer as an immutable build input') < sync.indexOf('Open validated update or draft requiring adaptation'));
  assert.ok(sync.includes('MIRROR_OUTCOME: ${{ steps.mirror.outcome }}'));
});
