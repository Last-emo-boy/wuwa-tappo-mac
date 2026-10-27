import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { profile, root, findSource } from './frontend-context.mjs';
import { patchGlobalAuthListener } from '../scripts/patch-frontend.mjs';

const originalBridge = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
const current = 'try{const t=await getCurrent();t?.length&&handleRawUrls(t)}catch(t){console.warn("[overseas-auth] getCurrent failed:",t)}';
const listener = 'try{unlisten=await onOpenUrl(t=>{handleRawUrls(t)})}catch(t){throw console.warn("[overseas-auth] onOpenUrl failed:",t),bound=!1,t}';
const fixture = `${originalBridge}async function bindOverseasAuthDeepLink(e){if(successHandler=e.onSuccess,errorHandler=e.onError??null,bound)return()=>{};bound=!0;${current}${listener}return()=>{unlisten?.(),unlisten=null,bound=!1,successHandler=null,errorHandler=null}}`;

test('GLOBAL OAuth listens before reading cold callbacks and fetches URLs through the protected command', async () => {
  const order = [], events = new Map(), deliveries = [];
  const pending = [['synthetic-cold-callback']];
  const patched = patchGlobalAuthListener(fixture);
  const env = vm.createContext({
    successHandler: null, errorHandler: null, bound: false, unlisten: null,
    console: { warn() { assert.fail('Unexpected OAuth bridge warning'); } },
    listen: async (event, callback) => { order.push('listen'); events.set(event, callback); return () => events.delete(event); },
    getCurrent: async () => { order.push('get'); return pending.shift() ?? []; },
    handleRawUrls: value => deliveries.push([...value]),
  });
  vm.runInContext(patched, env);
  const unlisten = await env.bindOverseasAuthDeepLink({ onSuccess() {} });
  assert.deepEqual(order, ['listen', 'get']);
  assert.deepEqual(deliveries, [['synthetic-cold-callback']]);
  assert.deepEqual([...events.keys()], ['mac-oauth-callback-ready']);
  pending.push(['synthetic-valid-B', 'synthetic-old-A']);
  await events.get('mac-oauth-callback-ready')({ payload: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deliveries.at(-1), ['synthetic-valid-B', 'synthetic-old-A']);
  assert.equal(patched.includes('e(t.payload)'), false);
  unlisten();
  assert.equal(events.size, 0);
});

test('unknown OAuth binding versions stop preparation', () => {
  assert.throws(() => patchGlobalAuthListener(''), /OAuth callback binding changed/);
  assert.throws(() => patchGlobalAuthListener(fixture.replace('getCurrent();', 'getOther();')), /OAuth callback binding changed/);
});

test('prepared resources preserve the selected region and contain its macOS adaptations', async () => {
  const mainSource = findSource(source => source.includes(`const APP_REGION="${profile.region}"`));
  const preparedMain = await readFile(path.join(root, profile.preparedDir, 'assets', mainSource.name), 'utf8');
  parse(preparedMain, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.ok(preparedMain.includes(`const APP_REGION="${profile.region}"`));
  assert.equal((preparedMain.match(/SESSION__\?\.flush\(\)/g) ?? []).length, 2);
  const about = findSource(source => /t=[$\w]+\(\(\)=>k\("about_content"\)/.test(source));
  const preparedAbout = await readFile(path.join(root, profile.preparedDir, 'assets', about.name), 'utf8');
  parse(preparedAbout, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.ok(preparedAbout.includes(profile.productName));
  const bootstrap = await readFile(path.join(root, profile.preparedDir, 'bootstrap.html'), 'utf8');
  assert.ok(bootstrap.includes(`<title>${profile.productName}</title>`));
  assert.ok(bootstrap.includes(`Wuwa Tappo · ${profile.label}`));
  if (profile.region === 'GLOBAL') {
    assert.ok(preparedMain.includes('listen("mac-oauth-callback-ready"'));
    assert.equal(preparedMain.includes('listen("deep-link://new-url"'), false);
    assert.ok(preparedMain.indexOf(listener) < preparedMain.indexOf(current));
  } else {
    assert.ok(preparedMain.includes('isdkSrc="https://pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/kr-sdk.js"'));
    const login = findSource(source => source.includes('async function we(e=!1)'));
    const preparedLogin = await readFile(path.join(root, profile.preparedDir, 'assets', login.name), 'utf8');
    assert.ok(preparedLogin.includes('document.getElementById("KrSDK")?.remove()'));
    parse(preparedLogin, { sourceType: 'module', ecmaVersion: 'latest' });
  }
});

test('official OAuth state filtering accepts queued B even when old callback A arrives before delivery', async () => {
  const handler = await readFile(new URL('./fixtures/global-oauth-handler.js', import.meta.url), 'utf8');
  let pending = 'B';
  const storage = new Map(), accepted = [], rejected = [];
  const env = vm.createContext({
    parseOverseasAuthCallback: state => ({ state }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    assertPendingStateMatches: state => state === pending,
    clearPendingState: () => { pending = null; },
    successHandler: async value => accepted.push(value.state),
    errorHandler: error => rejected.push(error.message),
  });
  vm.runInContext(handler, env);
  await env.handleRawUrls(['B', 'A']);
  assert.deepEqual(accepted, ['B']);
  assert.equal(rejected.length, 1);
  assert.equal(storage.get('overseas-oauth-done-B'), '1');
});
