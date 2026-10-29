import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getRegionProfile } from '../scripts/regions.mjs';
import { contract, verifyDomesticSdkAssetBinding, verifyGlobalCallbackBridge, verifySourceContract } from '../scripts/network-smoke.mjs';

const profile = getRegionProfile();
const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, profile.frontendDir, 'assets');

const currentCallback = 'async function getCurrent(){return await invoke("plugin:deep-link|get_current")}';
const officialCallback = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
const privateCallback = 'async function onOpenUrl(e){return await listen("mac-oauth-callback-ready",()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))})}';

test('domestic SDK loading follows exported bindings rather than minifier aliases', () => {
  const main = 'const useHead=()=>{},isdkSrc="script",isdkCss="style";export{useHead as a,isdkSrc as b,isdkCss as c}';
  for (const head of ['Re', 'Oe']) {
    const view = `import{a as ${head},b as S,c as C}from"./${contract.source.main}";${head}({link:[{rel:"stylesheet",href:C}],script:[{src:S,onload:()=>{}}]});`;
    assert.equal(verifyDomesticSdkAssetBinding(main, view), undefined);
    assert.throws(() => verifyDomesticSdkAssetBinding(main, view.replace('href:C', 'href:S')), /stylesheet must use/);
    assert.throws(() => verifyDomesticSdkAssetBinding(main, view.replace('src:S', 'src:C')), /script must use/);
    assert.throws(() => verifyDomesticSdkAssetBinding(main, view.replace('a as', 'unknown as')), /must import/);
    assert.throws(() => verifyDomesticSdkAssetBinding(main, view.replace('link:[{rel:"stylesheet",href:C}],', '')), /both SDK stylesheet and script/);
  }
});

test('OAuth callback transport accepts only the known official bridge or explicitly prepared private wake', () => {
  assert.equal(verifyGlobalCallbackBridge(currentCallback + officialCallback), 'official-url-event');
  assert.equal(verifyGlobalCallbackBridge(currentCallback + privateCallback, { prepared: true }), 'private-command-after-wake');
  assert.throws(() => verifyGlobalCallbackBridge(currentCallback + officialCallback, { prepared: true }), /private callback-ready/);
  assert.throws(() => verifyGlobalCallbackBridge(currentCallback + privateCallback), /Official Global OAuth event bridge changed/);
});

test('OAuth callback transport rejects URL-bearing wake payloads, wrong events and bypassed native reads', () => {
  const unsafePayload = privateCallback.replace('()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))}', 't=>{e(t.payload)}');
  for (const bridge of [unsafePayload, privateCallback.replace('mac-oauth-callback-ready', 'other-event'), privateCallback.replace('getCurrent().then', 'readFromPublicEvent().then')]) {
    assert.throws(() => verifyGlobalCallbackBridge(currentCallback + bridge, { prepared: true }), /private callback-ready/);
  }
  assert.throws(() => verifyGlobalCallbackBridge(currentCallback + privateCallback + ';listen("deep-link://new-url",e=>sink(e.payload))', { prepared: true }), /credential-bearing URL event payloads/);
  assert.throws(() => verifyGlobalCallbackBridge(privateCallback, { prepared: true }), /native get_current command/);
});

test('selected regional network contract matches the locked official frontend', async () => {
  const lock = JSON.parse(await readFile(path.join(root, profile.upstreamLock), 'utf8'));
  assert.equal(contract.region, profile.region);
  assert.equal(contract.application, `WuwaTappo-${profile.id} ${lock.version}`);
  assert.equal(contract.http.baseUrl, new URL(profile.configUrl).origin);
  assert.equal(contract.assets.publicHost, profile.assetsOrigin);
  assert.equal(contract.updater.indexPath, `/app/json-host/${profile.updaterHostFile}`);
  const result = await verifySourceContract();
  assert.equal(result.region, profile.region);
  assert.equal(result.businessEndpoints, 22);
  assert.equal(result.browserOAuthRequired, profile.region === 'GLOBAL');
  assert.equal(result.tauriHttpPluginUsed, false);
});

test('regional login semantics remain domestic SDK or state-bound global browser OAuth', () => {
  const global = profile.region === 'GLOBAL';
  assert.equal(contract.auth.mode, global ? 'browser_oauth' : 'embedded_dom_sdk');
  assert.equal(contract.auth.playerQuery.is_domestic, global ? 0 : 1);
  assert.equal(contract.auth.businessLogin.is_domestic, global ? 0 : 1);
  assert.equal(contract.auth.nativeDeepLinkRequired, global);
  assert.equal(contract.auth.businessTokenCookie, 'kuro_infoToken');
  assert.equal(contract.auth.pendingRoleStorageContainsSdkToken, true);
  assert.deepEqual(contract.auth.secureLocalStorageKeys, ['__KrSDK_USER_TOKEN__', '__KrSDK_USER_INFO__', 'overseas-pending-role-select']);
  if (global) {
    assert.equal(contract.auth.browser.scheme, 'wuwa-buddy');
    assert.equal(contract.auth.browser.pendingTtlMs, 900000);
    assert.equal(contract.auth.browser.loginUrl, 'https://login-wutheringwaves-wuwatappo.kurogames-global.com/login/');
  } else {
    assert.equal(contract.auth.sdk.environment, 'MAINLAND-PRODUCTION');
    assert.equal(contract.auth.sdk.mountElementId, 'KrSDK');
  }
});

test('verification rejects mismatched regional frontend rather than accepting the other service', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-regional-network-'));
  try {
    for (const filename of new Set(Object.values(contract.source))) {
      let source = await readFile(path.join(assets, filename), 'utf8');
      if (filename === contract.source.main) source = source.replace(`APP_REGION="${profile.region}"`, `APP_REGION="${profile.region === 'CN' ? 'GLOBAL' : 'CN'}"`);
      await writeFile(path.join(directory, filename), source);
    }
    await assert.rejects(verifySourceContract(directory), /Expected the .* frontend build/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing recovered frontend is a hard failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-missing-network-'));
  try { await assert.rejects(verifySourceContract(directory), { code: 'ENOENT' }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
