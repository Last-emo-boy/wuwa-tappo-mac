import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { patchMacUpdater, patchMacReleasesButton } from '../scripts/patch-frontend.mjs';
import { findSource, profile, root } from './frontend-context.mjs';

const releases = 'https://github.com/Last-emo-boy/wuwa-tappo-mac/releases';
const preparedSource = ({ name }) => readFile(path.join(root, profile.preparedDir, 'assets', name), 'utf8');
const ast = source => parse(source, { sourceType: 'module', ecmaVersion: 'latest' });

test('Mac updater startup and host changes never schedule Windows checks', async () => {
  const source = await preparedSource(findSource(value => value.includes('const APP_REGION="' + profile.region + '"')));
  const nodes = ast(source).body;
  const definitions = ['isAppUpdaterEnabled', 'checkForAppUpdate', 'setUpdaterAssetsHost', 'scheduleSilentAppUpdateCheck'];
  const functions = definitions.map(name => {
    const node = nodes.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(node, name);
    return source.slice(node.start, node.end);
  });
  const context = vm.createContext({
    isTauriRuntime: () => true,
    updaterAssetsHost: '',
    normalizeUpdaterAssetsHost: value => value,
    getUpdaterAssetsHost: () => context.updaterAssetsHost,
    LOCAL_ROLE_ASSETS_HOST: '__local_assets__',
    networkSnapshot: { value: { status: 'online' } },
    runSilentAppUpdateCheck: () => assert.fail('Unexpected Windows update check'),
    stopSilentAppUpdateCheck: () => assert.fail('Unexpected Windows update scheduler'),
  });
  vm.runInContext(functions.join('\n'), context);
  assert.equal(context.isAppUpdaterEnabled(), false);
  context.scheduleSilentAppUpdateCheck(0);
  context.setUpdaterAssetsHost('https://official.example/');
  assert.equal(context.updaterAssetsHost, 'https://official.example/');
  assert.equal((await context.checkForAppUpdate()).kind, 'disabled');
  assert.equal((await context.checkForAppUpdate({ interactive: true })).kind, 'disabled');
});

test('the prepared Settings control opens GitHub Releases and stays usable after failure', async () => {
  const source = await preparedSource(findSource(value => value.includes('"setting-btn btn-check-update"')));
  const control = source.match(/class:"setting-btn btn-check-update",disabled:([$\w]+)\.value,[^\n]+?onClick:[$\w]+\(([$\w]+),\["stop"\]\)\},"GitHub Releases"/);
  assert.ok(control, 'Mac release button must remain enabled independently of the official updater');
  const [, busy, name] = control;
  const handlers = [];
  function walk(node) {
    if (!node?.type) return;
    if (node.type === 'FunctionDeclaration' && node.id.name === name) {
      const text = source.slice(node.start, node.end);
      if (text.includes('plugin:opener|open_url')) handlers.push(text);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else walk(value);
  }
  walk(ast(source));
  assert.equal(handlers.length, 1);
  const status = handlers[0].match(/\.value=!0;([$\w]+)\.value="";/)?.[1];
  assert.ok(status);
  const calls = [], warnings = [];
  let respond;
  const state = vm.createContext({
    [busy]: { value: false },
    [status]: { value: '' },
    window: { __TAURI_INTERNALS__: { invoke(command, args) {
      calls.push({ command, url: args.url });
      return new Promise((resolve, reject) => { respond = { resolve, reject }; });
    } } },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(handlers[0], state);
  const opening = state[name]();
  assert.equal(state[busy].value, true);
  await state[name]();
  assert.deepEqual(calls, [{ command: 'plugin:opener|open_url', url: releases }]);
  respond.resolve();
  await opening;
  assert.equal(state[busy].value, false);
  assert.equal(state[status].value, '');
  const retry = state[name]();
  respond.reject(new Error('No browser'));
  await retry;
  assert.equal(state[busy].value, false);
  assert.equal(state[status].value, releases);
  assert.equal(warnings.length, 1);
});

test('unexpected upstream updater or Settings controls fail preparation', () => {
  assert.throws(() => patchMacUpdater('function isAppUpdaterEnabled(){return true}'), /updater guard changed/);
  assert.throws(() => patchMacReleasesButton(''), /update button changed/);
});
