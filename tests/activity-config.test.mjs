import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { patchActivityConfigConcurrency } from '../scripts/patch-frontend.mjs';
import { findSource, profile, root } from './frontend-context.mjs';

async function setup() {
  const { name } = findSource(value => value.includes('const APP_REGION="' + profile.region + '"'));
  const source = await readFile(path.join(root, profile.preparedDir, 'assets', name), 'utf8');
  const { body } = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const pending = body.find(node => node.type === 'VariableDeclaration'
    && node.declarations.some(item => item.id.name === '__wuwatappoActivityConfigPending'));
  const activity = body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'activityInfo');
  assert.ok(pending && activity);
  const requests = [];
  const definitions = [pending, activity].map(node => source.slice(node.start, node.end)).join('\n');
  const api = vm.runInNewContext(definitions + '\nactivityInfo', {
    jsonpClient: { get(url, params, options) {
      assert.equal(url, 'api/common/activity-config');
      assert.equal(Object.keys(params).length, 0);
      assert.equal(options.loading, false);
      assert.equal(options.reload, true);
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    } },
  });
  return { api, requests };
}

test('overlapping activity config consumers share a response, not a cached result', async () => {
  const { api, requests } = await setup();
  const first = api(), second = api();
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  const payload = { data: { server_time: 42 } };
  requests[0].resolve(payload);
  assert.deepEqual(await Promise.all([first, second]), [payload, payload]);
  const refresh = api();
  assert.notEqual(refresh, first);
  assert.equal(requests.length, 2);
  requests[1].resolve(payload);
  await refresh;
});

test('a real activity config failure reaches every caller and allows retry', async () => {
  const { api, requests } = await setup();
  const first = api(), second = api();
  assert.equal(requests.length, 1);
  const result = Promise.allSettled([first, second]);
  const error = new Error('offline');
  requests[0].reject(error);
  assert.deepEqual(await result, [{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
  const retry = api();
  assert.equal(requests.length, 2);
  requests[1].resolve({ data: { server_time: 43 } });
  assert.equal((await retry).data.server_time, 43);
});

test('an unknown activity config endpoint fails preparation instead of changing other requests', () => {
  const source = 'function activityInfo(){const args={loading:!1,reload:!0};return jsonpClient.get("api/common/other",{},args)}';
  assert.throws(() => patchActivityConfigConcurrency(source), /activity-config request changed/);
});
