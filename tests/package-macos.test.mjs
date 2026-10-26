import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '../scripts/package-macos.sh');

test('packaging exposes explicit application and output paths', () => {
  const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--app/);
  assert.match(result.stdout, /--output/);
});

test('packaging rejects incomplete arguments and missing application bundles', () => {
  const incomplete = spawnSync('bash', [script, '--app'], { encoding: 'utf8' });
  assert.equal(incomplete.status, 2);
  const missing = spawnSync('bash', [script, '--app', '/nonexistent/Wuwa Tappo CN Mac.app'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /未找到完整应用|需要在 Mac/);
});

test('packaging reports the failing stage and preserves the tool exit status', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wuwa-package-error-'));
  try {
    const app = path.join(directory, 'Broken.app');
    mkdirSync(path.join(app, 'Contents'), { recursive: true });
    writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>');
    const result = spawnSync('bash', [script, '--app', app], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    if (process.platform === 'darwin') {
      assert.match(result.stdout, /打包阶段：读取应用信息/);
      assert.match(result.stderr, /打包失败：读取应用信息（第 \d+ 行，退出状态 1）/);
    } else {
      assert.match(result.stderr, /需要在 Mac/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
