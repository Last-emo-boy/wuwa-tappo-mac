import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchMacUpdater } from '../scripts/patch-frontend.mjs';

const failure = 'if(logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:e?.interactive?"report_error":"treat_as_latest"},"warn"),e?.interactive)return{kind:"error",message:n};try{const s=await getVersion();return console.warn("[updater] check skipped (treat as latest)",t),{kind:"none",currentVersion:s}}catch{return{kind:"error",message:n}}';
const source = `
async function resolveUpdaterLatestJsonUrl(){const e=resolveUpdaterLatestHostJsonUrl();if(!e)return null;return e}
async function checkForAppUpdate(e){try{throw new Error("offline")}catch(t){const n=t.message;${failure}}}
({resolveUpdaterLatestJsonUrl,checkForAppUpdate})`;

function runtime(initialHost, config) {
  let host = initialHost;
  let reads = 0;
  const logs = [];
  const api = vm.runInNewContext(patchMacUpdater(source), {
    resolveUpdaterLatestHostJsonUrl: () => host && `${host}/app/json-host/latest_host.json`,
    activityInfo: async () => { reads += 1; return config; },
    unwrapApiData: value => value.data,
    LOCAL_ROLE_ASSETS_HOST: '__local_role_assets__',
    setUpdaterAssetsHost: (value, options) => { assert.equal(options.triggerSilentCheck, false); host = value; },
    logDiagnostic: (...args) => logs.push(args),
    diagnosticErrorCode: () => 'network',
    getVersion: () => { throw new Error('A failed check must not be treated as latest'); },
  });
  return { api, logs, reads: () => reads };
}

test('an uninitialized auxiliary window gets its update host from the official config', async () => {
  const context = runtime('', { data: { assets_host: 'https://official.example' } });
  assert.equal(await context.api.resolveUpdaterLatestJsonUrl(), 'https://official.example/app/json-host/latest_host.json');
  assert.equal(context.reads(), 1);
  await context.api.resolveUpdaterLatestJsonUrl();
  assert.equal(context.reads(), 1);
});

test('an existing update host needs no additional config request', async () => {
  const context = runtime('https://existing.example');
  assert.equal(await context.api.resolveUpdaterLatestJsonUrl(), 'https://existing.example/app/json-host/latest_host.json');
  assert.equal(context.reads(), 0);
});

test('missing or local-only config is an explicit failure', async () => {
  for (const host of ['', '__local_role_assets__']) {
    const context = runtime('', { data: { assets_host: host } });
    await assert.rejects(context.api.resolveUpdaterLatestJsonUrl(), /官方配置缺少更新资源地址/);
  }
});

test('interactive and silent update failures both remain failures', async () => {
  const context = runtime('https://existing.example');
  for (const interactive of [false, true]) {
    const result = await context.api.checkForAppUpdate({ interactive });
    assert.equal(result.kind, 'error');
    assert.equal(result.message, 'offline');
  }
  assert.equal(context.logs.length, 2);
});
