import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { patchMacShortcutLabels } from '../scripts/patch-frontend.mjs';
import { contract, profile, root, findSource } from './frontend-context.mjs';

const main = findSource(source => source.includes('const DEFAULT_APP_SHORTCUTS='));
const view = findSource(source => source.includes('function Ch(e)'));
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
  const save = declaration(settings.source, 'T', node => settings.source.slice(node.start, node.end).includes('set_app_shortcuts'));
  for (const error of [null, 'duplicate', 'occupied', 'unavailable']) {
    const events = [], warnings = [], calls = [];
    const old = { gameMode: { modifiers: 0, key: 118 }, switchScreen: { modifiers: 0, key: 119 }, togglePet: { modifiers: 0, key: 120 } };
    const env = vm.createContext({
      A: { value: false }, O: { value: 'recording' }, t: { action: 'togglePet' },
      qs: operation => operation(), ps: async () => structuredClone(old),
      ms: async (command, payload) => { calls.push({ command, payload: structuredClone(payload) }); if (error) throw error; },
      B: (type, payload) => events.push({ type, payload: structuredClone(payload) }),
      g: key => key, Oe: key => warnings.push(key),
    });
    vm.runInContext(save, env);
    await env.T({ modifiers: 8, key: 75 });
    assert.equal(env.A.value, false);
    assert.deepEqual(calls, [{ command: 'set_app_shortcuts', payload: { config: { ...old, togglePet: { modifiers: 8, key: 75 } } } }]);
    if (error) {
      assert.deepEqual(events, []);
      assert.deepEqual(warnings, [`setting_shortcut_${error}`]);
      assert.equal(env.O.value, '');
    } else {
      assert.deepEqual(events, [{ type: 'change', payload: calls[0].payload.config }]);
      assert.deepEqual(warnings, []);
    }
  }
});

test('official shortcut capture does not reactivate a blurred field after a delayed native reply', async () => {
  const focus = declaration(settings.source, 'M', node => settings.source.slice(node.start, node.end).includes('Gt(!0)'));
  const blur = declaration(settings.source, 'P', node => settings.source.slice(node.start, node.end).includes('Gt(!1)'));
  let finish;
  const calls = [];
  const env = vm.createContext({
    z: 0, C: { value: false }, f: { value: false }, O: { value: '' }, V: null,
    Gt: active => { calls.push(active); return active ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); },
    Oe: () => assert.fail('Unexpected capture error'), g: key => key, v: { value: { blur() {} } },
  });
  vm.runInContext(focus + blur, env);
  const pending = env.M();
  assert.equal(env.C.value, true);
  assert.equal(env.f.value, false);
  env.P();
  finish();
  await pending;
  assert.deepEqual(calls, [true, false]);
  assert.equal(env.C.value, false);
  assert.equal(env.f.value, false);
});

test('official app-shortcut consumer dispatches exactly one enabled action and honors the lock', () => {
  const handler = declaration(view.source, 'Ch');
  for (const locked of [false, true]) for (const enabled of [false, true]) {
    const effects = [];
    const env = vm.createContext({
      Ie: () => locked, ly: () => enabled, uy: () => enabled,
      mc: () => effects.push('togglePet'), Th: () => effects.push('gameMode'),
      [profile.id === 'cn' ? 'Pv' : 'Dv']: () => enabled,
      [profile.id === 'cn' ? 'Tv' : 'Lv']: () => effects.push('switchScreen'),
    });
    vm.runInContext(handler, env);
    for (const action of ['togglePet', 'gameMode', 'switchScreen', 'unknown']) env.Ch(action);
    assert.deepEqual(effects, !locked && enabled ? ['togglePet', 'gameMode', 'switchScreen'] : []);
  }
  assert.deepEqual(contract.events.find(event => event.name === 'app-shortcut').payload.enum, ['gameMode', 'switchScreen', 'togglePet']);
});

test('official fullscreen automation follows transitions without clearing a manually enabled mode when disabled', () => {
  const handler = declaration(view.source, 'Ph');
  const settings = { autoGameModeOnFullscreen: true };
  const effects = [], notices = [];
  const env = vm.createContext({
    ma: false, Qt: { value: false }, xt: () => settings,
    Ga: value => { env.Qt.value = value; effects.push(value); }, mt: key => notices.push(key), $: key => key,
  });
  vm.runInContext(handler, env);
  for (const fullscreen of [false, true, true, false, false]) env.Ph(fullscreen);
  assert.deepEqual(effects, [true, false]);
  assert.deepEqual(notices, ['game_mode_entered', 'game_mode_exited']);
  settings.autoGameModeOnFullscreen = false;
  env.Qt.value = true;
  env.Ph(false);
  assert.equal(env.Qt.value, true);
  assert.deepEqual(effects, [true, false]);
});

test('official desktop-safe-area consumer keeps application fullscreen separate from desktop fullscreen', async () => {
  const source = findSource(value => value.includes('typeof e.foregroundApplicationFullscreen=="boolean"')).source;
  const functions = ['zt', 'oe', 'qt', 'ie'].map(name => declaration(source, name)).join('\n');
  const insets = { left: 0, top: 0, right: 0, bottom: 0 };
  let reply;
  const env = vm.createContext({
    u: async command => command === 'get_main_desktop_safe_area' ? reply : insets,
    B: insets, F: null, D: false, he: false, q: null, we: insets,
    [profile.id === 'cn' ? 'V' : '$']: insets,
    console: { warn: () => assert.fail('Unexpected safe-area failure') },
  });
  vm.runInContext(functions, env);
  reply = { insets, autoHideEdge: null, foregroundFullscreen: false, foregroundApplicationFullscreen: true };
  await env.zt();
  assert.equal(env.D, false);
  assert.equal(env.he, true);
  reply = { insets, autoHideEdge: null, foregroundFullscreen: true, foregroundApplicationFullscreen: false };
  await env.zt();
  assert.equal(env.D, true);
  assert.equal(env.he, false);
  assert.equal(contract.commands.find(command => command.name === 'get_main_desktop_safe_area').response.properties.foregroundApplicationFullscreen.type, 'boolean');
});
