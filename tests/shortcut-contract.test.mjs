import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { patchMacShortcutLabels } from '../scripts/patch-frontend.mjs';
import { contract, profile, root, findSource } from './frontend-context.mjs';

const main = findSource(source => source.includes('const DEFAULT_APP_SHORTCUTS='));
const view = findSource(source => source.includes('[main] window layout during open failed'));
const settings = findSource(source => source.includes('__name:"ShortcutInput"'));

function nodes(source) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source, { sourceType: 'module', ecmaVersion: 'latest' }));
  return result;
}

function declaration(source, name, predicate = () => true) {
  const selected = nodes(source).filter(node => node.type === 'FunctionDeclaration' && node.id.name === name && predicate(node));
  assert.equal(selected.length, 1, `Expected one official ${name} function`);
  return source.slice(selected[0].start, selected[0].end);
}

function constant(source, name) {
  const selected = nodes(source).filter(node => node.type === 'VariableDeclarator' && node.id.name === name);
  assert.equal(selected.length, 1, `Expected one official ${name} binding`);
  return `const ${source.slice(selected[0].start, selected[0].end)};`;
}

test('official shortcut bindings retain VK values while macOS displays Option and Command', () => {
  const patched = patchMacShortcutLabels(main.source);
  const definitions = ['DEFAULT_APP_SHORTCUTS', 'namedKeys', 'keyLabels'].map(name => constant(patched, name)).join('\n');
  const functions = ['formatShortcut', 'formatModifiers', 'eventModifiers', 'keyFromEvent', 'formatPressedShortcut', 'shortcutFromEvent']
    .map(name => declaration(patched, name)).join('\n');
  const api = vm.runInNewContext(`${definitions}\n${functions}\n({ defaults: DEFAULT_APP_SHORTCUTS, formatShortcut, formatModifiers, shortcutFromEvent })`);
  const clone = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(clone(api.defaults), {
    gameMode: { modifiers: 0, key: 118 }, switchScreen: { modifiers: 0, key: 119 }, togglePet: { modifiers: 0, key: 120 },
    alwaysOnTop: { modifiers: 0, key: 0 }, autoGameModeOnFullscreen: { modifiers: 0, key: 0 }, disablePointerMonitoring: { modifiers: 0, key: 0 },
  });
  assert.deepEqual(clone(api.defaults), contract.runtimeConstants.appShortcuts);
  assert.deepEqual(clone(api.formatModifiers(15)), ['Ctrl', 'Option', 'Shift', 'Cmd']);
  assert.equal(api.formatShortcut({ modifiers: 8, key: 75 }), 'Cmd+K');
  assert.equal(api.formatShortcut({ modifiers: 1, key: 118 }), 'Option+F7');
  assert.equal(api.formatShortcut({ modifiers: 0, key: 0 }), '');
  assert.deepEqual(clone(api.shortcutFromEvent({ code: 'KeyK', key: 'k', metaKey: true })), { modifiers: 8, key: 75 });
  assert.deepEqual(clone(api.shortcutFromEvent({ code: 'KeyP', key: 'P', ctrlKey: true, altKey: true, shiftKey: true })), { modifiers: 7, key: 80 });
  assert.deepEqual(clone(api.shortcutFromEvent({ code: 'F7', key: 'F7' })), { modifiers: 0, key: 118 });
  assert.equal(api.shortcutFromEvent({ code: 'KeyK', key: 'K', shiftKey: true }), null);
  assert.equal(api.shortcutFromEvent({ code: 'KeyK', key: 'k' }), null);
  assert.throws(() => patchMacShortcutLabels(''), /modifier labels changed/);
  assert.throws(() => patchMacShortcutLabels(main.source.replace('[8,"Win"]', '[8,"Meta"]')), /modifier labels changed/);
  const prepared = readFileSync(path.join(root, profile.preparedDir, 'assets', main.name), 'utf8');
  assert.ok(prepared.includes(declaration(patched, 'formatModifiers')));
});

test('official settings save the complete shortcut map and retain actionable native errors', async () => {
  const save = declaration(settings.source, 'z', node => settings.source.slice(node.start, node.end).includes('set_app_shortcuts'));
  for (const error of [null, 'duplicate', 'occupied', 'unavailable']) {
    const events = [], warnings = [], calls = [];
    const old = { ...contract.runtimeConstants.appShortcuts, alwaysOnTop: { modifiers: 8, key: 71 } };
    const env = vm.createContext({
      A: { value: false }, N: { value: 'recording' }, t: { action: 'togglePet' },
      dn: operation => operation(), Is: async () => structuredClone(old),
      Cs: async (command, payload) => { calls.push({ command, payload: structuredClone(payload) }); if (error) throw error; },
      D: (type, payload) => events.push({ type, payload: structuredClone(payload) }),
      v: key => key, $e: key => warnings.push(key),
    });
    vm.runInContext(save, env);
    await env.z({ modifiers: 8, key: 75 });
    assert.equal(env.A.value, false);
    assert.deepEqual(calls, [{ command: 'set_app_shortcuts', payload: { config: { ...old, togglePet: { modifiers: 8, key: 75 } } } }]);
    if (error) {
      assert.deepEqual(events, []);
      assert.deepEqual(warnings, [`setting_shortcut_${error}`]);
      assert.equal(env.N.value, '');
    } else {
      assert.deepEqual(events, [{ type: 'change', payload: calls[0].payload.config }]);
      assert.deepEqual(warnings, []);
    }
  }
});

test('official shortcut capture does not reactivate a blurred field after a delayed native reply', async () => {
  const focus = declaration(settings.source, 'I', node => settings.source.slice(node.start, node.end).includes('ts(!0)'));
  const blur = declaration(settings.source, 'x', node => settings.source.slice(node.start, node.end).includes('ts(!1)'));
  let finish;
  const calls = [];
  const env = vm.createContext({
    k: 0, R: { value: false }, m: { value: false }, N: { value: '' }, T: null,
    ts: active => { calls.push(active); return active ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); },
    $e: () => assert.fail('Unexpected capture error'), v: key => key, d: { value: { blur() {} } },
  });
  vm.runInContext(focus + blur, env);
  const pending = env.I();
  assert.equal(env.R.value, true);
  assert.equal(env.m.value, false);
  env.x();
  finish();
  await pending;
  assert.deepEqual(calls, [true, false]);
  assert.equal(env.R.value, false);
  assert.equal(env.m.value, false);
});

test('official app-shortcut consumer dispatches exactly one enabled action and honors the lock', () => {
  const handler = declaration(view.source, '$h', node => view.source.slice(node.start, node.end).includes('disablePointerMonitoring'));
  const actions = ['togglePet', 'gameMode', 'switchScreen', 'alwaysOnTop', 'autoGameModeOnFullscreen', 'disablePointerMonitoring'];
  for (const locked of [false, true]) for (const enabled of [false, true]) {
    const effects = [], settings = {}, pointer = {value: false};
    const env = vm.createContext({
      Te: () => locked, Ky: () => enabled, zy: () => enabled,
      xc: () => effects.push('togglePet'), om: () => effects.push('gameMode'),
      [profile.id === 'cn' ? 'gg' : 'yg']: () => enabled,
      [profile.id === 'cn' ? 'yg' : 'wg']: () => effects.push('switchScreen'),
      jh: () => effects.push('alwaysOnTop'),
      Hn: update => Object.assign(settings, update), vt: () => settings, Oe: pointer, Kr: false,
      [profile.id === 'cn' ? 'mv' : 'vv']: () => effects.push('autoGameModeOnFullscreen'),
      [profile.id === 'cn' ? 'vv' : 'gv']: () => effects.push('disablePointerMonitoring'),
    });
    vm.runInContext(handler, env);
    for (const action of [...actions, 'unknown']) env.$h(action);
    assert.deepEqual(effects, locked ? [] : enabled ? actions : actions.slice(3));
    assert.equal(pointer.value, !locked);
  }
  assert.deepEqual(new Set(contract.events.find(event => event.name === 'app-shortcut').payload.enum), new Set(actions));
});

test('official fullscreen automation follows transitions without clearing a manually enabled mode when disabled', () => {
  const handler = declaration(view.source, 'nm', node => view.source.slice(node.start, node.end).includes('autoGameModeOnFullscreen'));
  const settings = { autoGameModeOnFullscreen: true };
  const effects = [];
  const env = vm.createContext({
    Kr: false, Et: { value: false }, vt: () => settings,
    is: value => { env.Et.value = value; effects.push(value); },
  });
  vm.runInContext(handler, env);
  for (const fullscreen of [false, true, true, false, false]) env.nm(fullscreen);
  assert.deepEqual(effects, [true, false]);
  settings.autoGameModeOnFullscreen = false;
  env.Et.value = true;
  env.nm(false);
  assert.equal(env.Et.value, true);
  assert.deepEqual(effects, [true, false]);
});

test('official desktop-safe-area consumer keeps application fullscreen separate from desktop fullscreen', async () => {
  const source = findSource(value => value.includes('typeof e.foregroundApplicationFullscreen=="boolean"')).source;
  const functions = ['$t', 'ce', 're', 'Vt'].map(name => declaration(source, name)).join('\n');
  const insets = { left: 0, top: 0, right: 0, bottom: 0 };
  let reply;
  const env = vm.createContext({
    u: async command => command === 'get_main_desktop_safe_area' ? reply : insets,
    W: insets, D: null, x: false, Se: false, q: null, ge: insets, $: insets,
    console: { warn: () => assert.fail('Unexpected safe-area failure') },
  });
  vm.runInContext(functions, env);
  reply = { insets, autoHideEdge: null, foregroundFullscreen: false, foregroundApplicationFullscreen: true };
  await env.$t();
  assert.equal(env.x, false);
  assert.equal(env.Se, true);
  reply = { insets, autoHideEdge: null, foregroundFullscreen: true, foregroundApplicationFullscreen: false };
  await env.$t();
  assert.equal(env.x, true);
  assert.equal(env.Se, false);
  assert.equal(contract.commands.find(command => command.name === 'get_main_desktop_safe_area').response.properties.foregroundApplicationFullscreen.type, 'boolean');
});
