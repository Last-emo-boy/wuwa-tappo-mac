import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'acorn';
import { patchDomesticLoginReload } from '../scripts/patch-frontend.mjs';

// The official CN bundle is minified, so identifiers drift between releases. Anchor on the
// reload guard shape and run the real loader against a stubbed DOM instead of hardcoding names.
const loaderSource = (await readFile(new URL('./fixtures/domestic-sdk-loader.js', import.meta.url), 'utf8'))
  .split('\n').slice(1).join('\n').trimEnd();
const patched = patchDomesticLoginReload(loaderSource);

const ast = parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
const declaration = ast.body.find(node => node.type === 'FunctionDeclaration');
const loader = patched.slice(declaration.start, declaration.end);

const nameOf = pattern => pattern.exec(loaderSource)?.[1];
const memoName = nameOf(/\{if\(([$\w]+)\)return \1;if\(!e&&/);
const loadedName = nameOf(/;if\(!e&&([$\w]+)\(\)\)/);
const initName = nameOf(/try\{return ([$\w]+)\(\),!0\}/);
const srcName = nameOf(/t\.src=([$\w]+)\(\)/);

const builtins = new Set(['undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Promise', 'String', 'Number',
  'Boolean', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'Symbol', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Reflect', 'Proxy', 'Function', 'globalThis', 'console', 'document', 'window', 'setTimeout',
  'clearTimeout', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'BigInt', 'Intl', 'URL', 'structuredClone', 'queueMicrotask', 'crypto', 'performance', 'fetch']);

function freeIdentifiers(source) {
  const declared = new Set();
  const referenced = new Set();
  const addPattern = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier') { declared.add(node.name); return; }
    for (const key of ['left', 'right', 'argument', 'properties', 'params', 'elements', 'value', 'id', 'init']) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(addPattern);
      else if (value && typeof value === 'object' && value.type) addPattern(value);
    }
  };
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    switch (node.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name);
        node.params.forEach(addPattern);
        break;
      case 'VariableDeclarator': addPattern(node.id); break;
      case 'CatchClause': if (node.param) addPattern(node.param); break;
      case 'MemberExpression': collect(node.object); if (node.computed) collect(node.property); return;
      case 'Property': if (node.computed) collect(node.key); collect(node.value); return;
      case 'MethodDefinition': collect(node.value); return;
      case 'Identifier': referenced.add(node.name); return;
      default: break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') collect(value);
    }
  })(parse(source, { sourceType: 'module', ecmaVersion: 'latest' }));
  return [...referenced].filter(name => !declared.has(name) && !builtins.has(name));
}

const freeNames = freeIdentifiers(loaderSource);
const renderer = await readFile(new URL('./fixtures/kuro-sdk-preact.js', import.meta.url), 'utf8');

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
  const sandbox = { document, console, window: { setTimeout() { return 1; }, clearTimeout() {} } };
  for (const name of freeNames) sandbox[name] = () => undefined;
  sandbox[memoName] = null;
  sandbox[loadedName] = () => loaded;
  sandbox[initName] = () => { actions.push('existing-sdk-initialized'); };
  sandbox[srcName] = () => oldScript.src;
  const context = vm.createContext(sandbox);
  const reload = vm.runInContext(`(${loader})`, context);
  return { actions, outer, appended, document, context, reload };
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
  const insertion = ',e&&([...document.scripts].filter(s=>s.src===t.src).forEach(s=>s.remove()),document.getElementById("KrSDK")?.remove())';
  assert.throws(() => patchDomesticLoginReload(''), /reload function changed/);
  assert.throws(() => patchDomesticLoginReload(loaderSource.replace('t.dataset.kuroSdkRetry="true"', 't.dataset.changed="true"')), /script insertion changed/);
  assert.throws(() => patchDomesticLoginReload(loaderSource.replace(',document.head.appendChild(t),r=window.setTimeout(', ',document.head.append(t),r=window.setTimeout(')), /script insertion changed/);
  assert.equal(patched.replace(insertion, ''), loaderSource);
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
