import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegionProfile } from '../scripts/regions.mjs';
import { tauriArguments } from '../scripts/app.mjs';

test('CN retains its existing resource paths and application identity', () => {
  const cn = getRegionProfile('cn');
  assert.equal(cn.identifier, 'dev.w33d.wuwatappo.cn.mac');
  assert.equal(cn.frontendDir, 'frontend');
  assert.equal(cn.preparedDir, 'build/frontend');
  assert.equal(cn.tauriConfig, null);
  assert.deepEqual(tauriArguments('build', cn), ['build', '--bundles', 'app']);
});

test('Global has separate inputs, prepared resources, icon output and application identity', () => {
  const cn = getRegionProfile('cn'), global = getRegionProfile('global');
  for (const key of ['identifier', 'productName', 'frontendDir', 'preparedDir', 'iconsDir', 'upstreamLock', 'configUrl', 'assetsOrigin', 'artifactPrefix']) {
    assert.notEqual(cn[key], global[key], key);
  }
  assert.deepEqual(tauriArguments('build', global, ['--', '--locked']), [
    'build', '--bundles', 'app', '--config', 'src-tauri/tauri.global.conf.json', '--', '--locked',
  ]);
  assert.deepEqual(tauriArguments('icons', global), ['icon', 'frontend-global/app-icon.png', '--output', 'src-tauri/icons-global']);
});

test('unknown regions fail rather than silently selecting an account environment', () => {
  for (const region of ['CN', 'international', '', '__proto__', 'constructor']) {
    assert.throws(() => getRegionProfile(region), /未知服务区域/);
  }
  assert.throws(() => tauriArguments('install', getRegionProfile('cn')), /未知构建操作/);
});

test('Rust test entry point applies Global configuration without changing existing CN overrides', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-cargo-entry-'));
  try {
    await writeFile(path.join(directory, 'cargo'), '#!/bin/sh\nprintf \'%s\' "${TAURI_CONFIG:-null}"\n', { mode: 0o755 });
    const entry = fileURLToPath(new URL('../scripts/app.mjs', import.meta.url));
    const run = region => spawnSync(process.execPath, [entry, 'test:rust'], {
      encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`, WUWA_REGION: region, TAURI_CONFIG: '{"legacy":true}' },
    });
    const cn = run('cn'), global = run('global');
    assert.equal(cn.status, 0, cn.stderr);
    assert.equal(global.status, 0, global.stderr);
    assert.deepEqual(JSON.parse(cn.stdout), { legacy: true });
    assert.equal(JSON.parse(global.stdout).identifier, getRegionProfile('global').identifier);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
