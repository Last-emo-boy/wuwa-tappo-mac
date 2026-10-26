import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { measureImage } from '../scripts/dmg-size.mjs';

const script = path.resolve(import.meta.dirname, '../scripts/package-macos.sh');
const MIB = 1024 * 1024;

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

test('DMG capacity uses sparse-file logical size rather than allocated disk blocks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wuwa-dmg-sparse-'));
  try {
    const filename = path.join(directory, 'payload');
    writeFileSync(filename, '');
    truncateSync(filename, 512 * MIB);
    assert.deepEqual(await measureImage(directory), { logicalBytes: 512 * MIB, sizeMiB: 640 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('DMG capacity reserves filesystem space for small payloads', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wuwa-dmg-small-'));
  try {
    assert.deepEqual(await measureImage(directory), { logicalBytes: 0, sizeMiB: 64 });
    const filename = path.join(directory, 'payload');
    writeFileSync(filename, '');
    truncateSync(filename, 64 * MIB);
    assert.deepEqual(await measureImage(directory), { logicalBytes: 64 * MIB, sizeMiB: 96 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('DMG sizing counts symlinks without traversing outside the packaging directory', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wuwa-dmg-link-'));
  try {
    const content = path.join(directory, 'content');
    const external = path.join(directory, 'external');
    mkdirSync(content);
    mkdirSync(external);
    writeFileSync(path.join(external, 'large-file'), '');
    truncateSync(path.join(external, 'large-file'), 512 * MIB);
    symlinkSync(external, path.join(content, 'Applications'));
    symlinkSync(content, path.join(content, 'cycle'));
    const result = await measureImage(content);
    assert.equal(result.logicalBytes, Buffer.byteLength(external) + Buffer.byteLength(content));
    assert.equal(result.sizeMiB, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
