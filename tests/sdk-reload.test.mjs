import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { patchDomesticLoginReload } from '../scripts/patch-frontend.mjs';
import { profile, findSource } from './frontend-context.mjs';

const original = profile.region === 'CN'
  ? findSource(source => source.includes('async function we(e=!1)')).source
  : await readFile(new URL('./fixtures/domestic-sdk-loader.js', import.meta.url), 'utf8');
const renderer = await readFile(new URL('./fixtures/kuro-sdk-preact.js', import.meta.url), 'utf8');
const patched = patchDomesticLoginReload(original);
const loader = patched.slice(patched.indexOf('async function we(e=!1)'), patched.indexOf('async function me()'));

function setup({ loaded = true, root = { childNodes: [], firstChild: null } } = {}) {
  const actions = [];
  let currentRoot = root;
  const outer = { id: 'app', intact: true };
  const oldScript = { src: 'https://pro-cdn-sdk.kurogame.com/pro/web-sdk/1.x/kr-sdk.js', remove() { actions.push('old-sdk-script-removed'); } };
  const unrelated = { src: 'https://example.com/unrelated.js', remove() { actions.push('unrelated-script-removed'); } };
  if (currentRoot) currentRoot.remove = () => { actions.push('sdk-root-removed'); currentRoot = null; };
  const appended = [];
  const document = {
    scripts: [oldScript, unrelated],
    createElement() { return { dataset: {}, remove() { actions.push('new-script-removed'); } }; },
    getElementById(id) { return id === 'KrSDK' ? currentRoot : id === 'app' ? outer : null; },
    head: { appendChild(element) { actions.push('new-script-appended'); appended.push(element); } },
  };
  const context = vm.createContext({
    document, console,
    window: { setTimeout() { return 1; }, clearTimeout() {} },
    E: null, S: null, b: null, P: null, x: 0, u: 'ready', te: null, W: 0, We: 8000,
    $: () => loaded, re: () => actions.push('existing-sdk-initialized'),
    tn: () => oldScript.src, l() {}, c() {},
  });
  vm.runInContext(loader, context);
  return { actions, outer, appended, document, context, reload: force => context.we(force) };
}

test('only forced reload removes the exact old SDK script and SDK root before insertion', async () => {
  const env = setup();
  const pending = env.reload(true);
  assert.deepEqual(env.actions, ['old-sdk-script-removed', 'sdk-root-removed', 'new-script-appended']);
  assert.equal(env.outer.intact, true);
  assert.equal(env.document.getElementById('app'), env.outer);
  assert.equal(env.document.getElementById('KrSDK'), null);
  env.appended[0].onload();
  assert.equal(await pending, true);
});

test('non-forced reuse and first script loading preserve existing DOM', async () => {
  const existing = setup();
  assert.equal(await existing.reload(false), true);
  assert.deepEqual(existing.actions, ['existing-sdk-initialized']);
  const initial = setup({ loaded: false });
  const pending = initial.reload(false);
  assert.deepEqual(initial.actions, ['new-script-appended']);
  assert.notEqual(initial.document.getElementById('KrSDK'), null);
  initial.appended[0].onload();
  assert.equal(await pending, false);
});

test('the existing in-flight guard avoids a second cleanup or script insertion', async () => {
  const env = setup();
  const first = env.reload(true);
  const second = env.reload(true);
  assert.equal(env.appended.length, 1);
  env.appended[0].onload();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('unknown upstream loader shapes fail instead of applying a broad DOM patch', () => {
  assert.throws(() => patchDomesticLoginReload(''), /reload function changed/);
  assert.throws(() => patchDomesticLoginReload(original.replace('t.dataset.kuroSdkRetry="true"', 't.dataset.changed="true"')), /script insertion changed/);
  assert.throws(() => patchDomesticLoginReload(original.replace(',document.head.appendChild(t),r=window.setTimeout(', ',document.head.append(t),r=window.setTimeout(')), /script insertion changed/);
  assert.equal(patched.replace(',e&&([...document.scripts].filter(s=>s.src===t.src).forEach(s=>s.remove()),document.getElementById("KrSDK")?.remove())', ''), original);
});

test('the actual bundled Preact skips a new SDK App on a stale root but renders after forced-root cleanup', async () => {
  const context = vm.createContext({ document: {}, setTimeout, clearTimeout });
  const runtime = () => vm.runInContext(`(()=>{${renderer};return {render:P,h:h$1};})()`, context);
  const first = runtime();
  const second = runtime();
  const oldRoot = { childNodes: [], firstChild: null };
  let firstRenders = 0;
  let staleRenders = 0;
  let cleanRenders = 0;
  first.render(first.h(() => { firstRenders += 1; return null; }, {}), oldRoot);
  second.render(second.h(() => { staleRenders += 1; return null; }, {}), oldRoot);
  assert.equal(firstRenders, 1);
  assert.equal(staleRenders, 0);

  const env = setup({ root: oldRoot });
  const pending = env.reload(true);
  assert.equal(env.document.getElementById('KrSDK'), null);
  // The public SDK createEl() now creates a fresh root because the stale one is absent.
  const freshRoot = { childNodes: [], firstChild: null };
  const reloaded = runtime();
  reloaded.render(reloaded.h(() => { cleanRenders += 1; return null; }, {}), freshRoot);
  assert.equal(cleanRenders, 1);
  env.appended[0].onload();
  assert.equal(await pending, true);
});
