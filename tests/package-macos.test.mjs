import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
