import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { patchSessionBarriers, patchLoginReady, patchDomesticSdkUrls, patchMacUpdateFeedback, patchMacAbout } from '../scripts/patch-frontend.mjs';

const root = new URL('../', import.meta.url);
import { contract } from './frontend-context.mjs';

test('every application runtime command has a macOS handler', async () => {
  const modules = ['lib', 'windows', 'storage', 'input', 'system'];
  const implementation = (await Promise.all(modules.map(name => readFile(new URL(`src-tauri/src/${name}.rs`, root), 'utf8')))).join('\n');
  const missing = contract.commands.filter(c => c.kind === 'application' && c.scopes.includes('application-runtime'))
    .filter(c => !implementation.includes(`"${c.name}"`) && !implementation.includes(`fn ${c.name}(`))
    .map(c => c.name);
  assert.deepEqual(missing, []);
});

test('session flush barriers cover both SDK invoke wrappers without changing native internals', () => {
  const wrapper = name => `async function ${name}(e,t={},n){return window.__TAURI_INTERNALS__.invoke(e,t,n)}`;
  const source = `${wrapper('invoke$1')}${wrapper('invoke')}`;
  const result = patchSessionBarriers(source);
  assert.equal((result.match(/SESSION__\?\.flush\(\)/g) || []).length, 2);
  assert.ok(result.includes('cat-auth-login-success'));
  assert.ok(result.includes('cat-auth-logout'));
  assert.ok(result.includes('open_login_window'));
  assert.ok(!result.includes('__TAURI_INTERNALS__.invoke='));
});

test('unknown upstream wrapper versions fail the build instead of dropping the barrier', () => {
  assert.throws(() => patchSessionBarriers('async function invoke(){}'), /Expected 2/);
});

test('first login waits for the Vue modal listener rather than a page-load timer', () => {
  const result=patchLoginReady('function N(n){return o(u,t=>{n(t.payload??{})})}');
  assert.ok(result.indexOf('await o(u,')<result.indexOf('invoke("login_window_ready")'));
  assert.ok(result.includes('return unlisten'));
  assert.throws(()=>patchLoginReady(''),/listener bridge changed/);
});

test('CN SDK script and stylesheet use HTTPS from the local Tauri origin', () => {
  const source = 'const APP_REGION="CN";const isdkSrc="//pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/kr-sdk.js",isdkCss="//pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/style.css";';
  const result = patchDomesticSdkUrls(source);
  assert.ok(result.includes('isdkSrc="https://pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/kr-sdk.js"'));
  assert.ok(result.includes('isdkCss="https://pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/style.css"'));
  assert.throws(() => patchDomesticSdkUrls(source.replace('"CN"', '"GLOBAL"')), /official CN frontend/);
  assert.throws(() => patchDomesticSdkUrls('const APP_REGION="CN";'), /Expected 2 CN SDK URLs/);
});

test('Mac update feedback preserves the native platform explanation', () => {
  assert.equal(patchMacUpdateFeedback('if(h.kind==="error"){ht("check_failed"),ge.value=n("setting_version_check_failed");return}'), 'if(h.kind==="error"){ht("check_failed"),ge.value=h.message||n("setting_version_check_failed");return}');
  assert.throws(() => patchMacUpdateFeedback(''), /update feedback changed/);
});

test('About separates the Mac build target from official Windows requirements', () => {
  const patched = patchMacAbout('t=b(()=>k("about_content")?String(v("about_content")).trim():"");<h2 data-v-439444c8>系统配置</h2>');
  assert.ok(patched.includes('Apple Silicon'));
  assert.ok(patched.includes('Windows 原版系统配置'));
  assert.ok(patched.includes('html.replace("系统配置","Windows 原版系统配置")'));
  assert.throws(() => patchMacAbout(''), /About system section changed/);
});

test('traditional Chinese remote About requirements remain identified as Windows', () => {
  const source = 'let t=f(()=>k("about_content")?String(v("about_content")).trim():"");<h2 data-v-160f56ac>系统配置</h2>';
  const patched = patchMacAbout(source, 'GLOBAL');
  const result = vm.runInNewContext(patched.slice(0, patched.indexOf(';<h2')) + ';t', {
    f: callback => callback(), k: () => true,
    v: () => '<h2>系統配備</h2><p>Windows 10 / Windows 11 64位元</p>',
  });
  assert.ok(result.includes('Wuwa Tappo Global Mac'));
  assert.ok(result.includes('<h2>Windows 原版系統配備</h2>'));
  assert.ok(result.includes('Windows 10 / Windows 11 64位元'));
});
