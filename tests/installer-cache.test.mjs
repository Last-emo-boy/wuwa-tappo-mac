import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRegionProfile } from '../scripts/regions.mjs';
import { pinnedInstallerCache, syncUpstream } from '../scripts/sync-upstream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bytes = Buffer.from('pinned official installer fixture');
function fixtureLock(region = 'cn') {
  const profile = getRegionProfile(region);
  return {
    schemaVersion: 1, region: profile.region, version: '1.0.2',
    manifestUrl: `${profile.assetsOrigin}/app/version-json/latest.json`,
    installer: { url: `${profile.assetsOrigin}/app/release/WuwaTappo-${region}_1.0.2_x64-setup.exe`, signature: 'public-signature', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}

test('installer Actions cache identity is exact region, content digest and size with the existing official cache path', () => {
  for (const region of ['cn', 'global']) {
    const profile = getRegionProfile(region), lock = fixtureLock(region);
    const cache = pinnedInstallerCache(lock, '/project', profile);
    assert.equal(cache.key, `official-installer-v1-${region}-${bytes.length}-${lock.installer.sha256}-${encodeURIComponent(new URL(lock.installer.url).pathname)}`);
    assert.equal(cache.path, `/project/.work/installers/app/release/WuwaTappo-${region}_1.0.2_x64-setup.exe`);
    assert.notEqual(pinnedInstallerCache({ ...lock, installer: { ...lock.installer, size: bytes.length + 1 } }, '/project', profile).key, cache.key);
    assert.notEqual(pinnedInstallerCache({ ...lock, installer: { ...lock.installer, sha256: '0'.repeat(64) } }, '/project', profile).key, cache.key);
    assert.notEqual(pinnedInstallerCache({ ...lock, installer: { ...lock.installer, url: lock.installer.url.replace('/release/', '/republished/') } }, '/project', profile).key, cache.key);
    assert.throws(() => pinnedInstallerCache({ ...lock, installer: { ...lock.installer, sha256: undefined } }, '/project', profile), /SHA-256/);
    assert.throws(() => pinnedInstallerCache({ ...lock, installer: { ...lock.installer, url: lock.installer.url.replace(profile.assetsOrigin, 'https://example.com') } }, '/project', profile), /官方 HTTPS/);
    assert.throws(() => pinnedInstallerCache(lock, '/project', getRegionProfile(region === 'cn' ? 'global' : 'cn')));
  }
});

test('cache metadata CLI emits only the selected region pinned file and immutable key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-cache-output-'));
  try {
    for (const region of ['cn', 'global']) {
      const output = path.join(directory, `${region}.out`);
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/installer-cache.mjs')], { encoding: 'utf8', env: { ...process.env, WUWA_REGION: region, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      const cache = JSON.parse(result.stdout);
      const lock = JSON.parse(await readFile(path.join(root, `upstream-${region}.json`), 'utf8'));
      assert.deepEqual(cache, pinnedInstallerCache(lock, root, getRegionProfile(region)));
      assert.equal(await readFile(output, 'utf8'), `key=${cache.key}\npath=${cache.path}\n`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restored installers avoid network but remain size and digest verified before extraction', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-cache-verified-'));
  const previousRegion = process.env.WUWA_REGION, previousFetch = globalThis.fetch;
  const previousMirror = process.env.WUWA_INSTALLER_MIRROR_BASE;
  try {
    const lock = fixtureLock();
    const cache = pinnedInstallerCache(lock, directory);
    process.env.WUWA_REGION = 'cn';
    delete process.env.WUWA_INSTALLER_MIRROR_BASE;
    await mkdir(path.dirname(cache.path), { recursive: true });
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'upstream-cn.json'), JSON.stringify(lock));
    const sevenzip = path.join(directory, '7zz');
    await writeFile(sevenzip, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(directory, 'scripts/extract-assets.mjs'), `
      import { mkdir, writeFile } from 'node:fs/promises';
      const output = process.argv[process.argv.indexOf('--output') + 1];
      await mkdir(output, { recursive: true });
      await writeFile(output + '/index.html', '<html></html>');
      console.log(JSON.stringify({ count: 1, staticReferences: 0 }));
    `);
    globalThis.fetch = async () => assert.fail('a restored pinned installer must not need network');
    await writeFile(cache.path, bytes);
    const result = await syncUpstream({ sevenzip }, directory);
    assert.equal(result.version, '1.0.2');
    assert.equal(await readFile(path.join(directory, 'frontend/index.html'), 'utf8'), '<html></html>');
    for (const corrupt of [bytes.subarray(1), Buffer.alloc(bytes.length)]) {
      await rm(path.join(directory, 'frontend'), { recursive: true, force: true });
      await writeFile(cache.path, corrupt);
      await assert.rejects(syncUpstream({ sevenzip }, directory), /大小不匹配|SHA-256 不匹配/);
      await assert.rejects(access(path.join(directory, 'frontend')), { code: 'ENOENT' });
    }
    await rm(cache.path);
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, 'error');
      return { ok: true, arrayBuffer: async () => bytes };
    };
    await syncUpstream({ sevenzip }, directory);
    assert.deepEqual(requests, [lock.installer.url]);
    assert.deepEqual(await readFile(cache.path), bytes);
    await rm(cache.path);
    await rm(path.join(directory, 'frontend'), { recursive: true });
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('official connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); };
    await assert.rejects(syncUpstream({ sevenzip }, directory), error => error.message.includes(lock.installer.url) && error.message.includes('CN 安装包下载') && error.message.includes('第 3 次请求') && error.message.includes('UND_ERR_CONNECT_TIMEOUT'));
    await assert.rejects(access(cache.path), { code: 'ENOENT' });
    await assert.rejects(access(path.join(directory, 'frontend')), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegion === undefined) delete process.env.WUWA_REGION;
    else process.env.WUWA_REGION = previousRegion;
    if (previousMirror === undefined) delete process.env.WUWA_INSTALLER_MIRROR_BASE;
    else process.env.WUWA_INSTALLER_MIRROR_BASE = previousMirror;
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflows restore exact pins before setup and save only verified installer files', async () => {
  const build = await readFile(path.join(root, '.github/workflows/build.yml'), 'utf8');
  const sync = await readFile(path.join(root, '.github/workflows/sync-upstream.yml'), 'utf8');
  const restore = build.match(/      - name: Restore pinned official installer[\s\S]*?(?=      - )/)?.[0];
  assert.ok(restore);
  assert.ok(restore.includes('path: ${{ steps.installer.outputs.path }}'));
  assert.ok(restore.includes('key: ${{ steps.installer.outputs.key }}'));
  assert.ok(!restore.includes('restore-keys'));
  assert.ok(build.indexOf('Restore pinned official installer') < build.indexOf('run: npm run setup'));
  assert.match(build, /Save verified official installer\n\s+if: steps\.prepare\.outcome == 'success' && steps\.installer-cache\.outputs\.cache-hit != 'true'/);
  assert.match(sync, /Read verified candidate installer cache identity\n\s+id: installer\n\s+if: steps\.extract\.outcome == 'success'/);
  assert.match(sync, /Save verified candidate official installer\n\s+if: steps\.extract\.outcome == 'success'/);
  assert.ok(sync.indexOf('Save verified candidate official installer') > sync.indexOf('node scripts/sync-upstream.mjs --update-lock'));
  assert.ok(sync.includes('path: ${{ steps.installer.outputs.path }}'));
  assert.ok(sync.includes('key: ${{ steps.installer.outputs.key }}'));
});
