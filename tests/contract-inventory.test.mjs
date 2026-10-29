import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { inventoryAssets } from '../scripts/inventory-contract.mjs';

import { contract, profile, root, assetDirectory } from './frontend-context.mjs';
const runtimeCommands = contract.commands.filter(item => item.kind === 'application' && item.scopes.includes('application-runtime'));

test('selected region runtime and Windows installer have separate exhaustive inventories', () => {
  assert.equal(runtimeCommands.length, 50);
  assert.equal(contract.commands.filter(item => item.kind === 'application' && item.scopes.includes('windows-installer')).length, profile.id === 'cn' ? 9 : 11);
  assert.equal(contract.commands.filter(item => item.kind === 'plugin').length, profile.id === 'cn' ? 119 : 120);
  assert.equal(contract.events.length, profile.id === 'cn' ? 60 : 61);
  assert.equal(contract.sourceApplication.region, profile.region);
  assert.equal(contract.sourceApplication.version, JSON.parse(fs.readFileSync(path.join(root, profile.upstreamLock), 'utf8')).version);
  assert.equal(Object.hasOwn(contract.runtimeConstants, 'authCallbackScheme'), profile.id === 'global');
  assert.equal(contract.commands.some(item => item.name === 'plugin:deep-link|get_current'), profile.id === 'global');
  assert.equal(contract.events.some(item => item.name === 'deep-link://new-url'), profile.id === 'global');
  assert.equal(new Set(contract.commands.map(item => item.name)).size, contract.commands.length);
  for (const item of runtimeCommands) {
    assert.ok(item.response, `${item.name} requires a consumer response contract`);
    assert.ok(item.callSites.length > 0);
    assert.deepEqual(item.scopes, ['application-runtime']);
  }
  assert.ok(contract.commands.find(item => item.name === 'start_silent_nsis_install').scopes.every(scope => scope === 'windows-installer'));
});

test('committed inventory matches every call site in the selected upstream version', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, profile.upstreamLock), 'utf8'));
  assert.deepEqual(inventoryAssets(assetDirectory, { version: lock.version }), contract);
});

test('all command and event evidence preserves JavaScript and UTF-8 byte ranges', () => {
  for (const entry of [...contract.commands, ...contract.events]) for (const site of entry.callSites) {
    assert.equal(site.charRange[1] - site.charRange[0], site.source.length, `${entry.name}: char range`);
    assert.equal(site.byteRange[1] - site.byteRange[0], Buffer.byteLength(site.source), `${entry.name}: byte range`);
    assert.ok(site.file.endsWith('.js'));
    assert.ok(site.context.includes(site.source));
  }
  assert.ok(contract.commands.find(item => item.name === 'get_boot_diagnostics').callSites.some(site => site.callee !== 'invoke'));
  assert.ok(contract.commands.find(item => item.name === 'open_panel_window').callSites.some(site => site.callee === '_'));
});

test('remaining dynamic invoke sites are framework plugin factories rather than missing application commands', () => {
  const dynamicInvocations = contract.dynamicCalls.filter(site => site.role === 'invoke');
  assert.equal(dynamicInvocations.length, 5);
  for (const site of dynamicInvocations) {
    assert.equal(site.category, 'framework-plugin-factory');
    assert.match(site.source, /plugin:\$\{/);
  }
});

test('keyboard and mouse payloads cannot accidentally share a count stream', () => {
  const find = name => contract.events.find(item => item.name === name);
  assert.equal(find('key-press').payload.type, 'string');
  assert.equal(find('key-release').payload.type, 'string');
  assert.equal(find('mouse-move').payload.properties.x.type, 'number');
  assert.equal(find('mouse-move').payload.properties.y.type, 'number');
  assert.deepEqual(find('mouse-button').payload.properties.button.enum, ['left', 'right', 'middle']);
  assert.deepEqual(find('mouse-button').payload.properties.action.enum, ['press', 'release']);
  assert.equal(find('mouse-button').payload.properties.memberId.type, 'number');
  assert.match(find('mouse-button').notes, /Do not also emit key-press/);
  assert.ok(find('mouse-button').callSites[0].payloadReads.includes('memberId'));
});

test('official gamepad consumer counts once, keeps feedback and respects both input guards', () => {
  const event = contract.events.find(item => item.name === 'gamepad-button-press');
  assert.deepEqual(event.payload, { type: 'undefined' });
  assert.deepEqual(event.operations, ['listen']);
  assert.equal(event.callSites.length, 1);
  assert.deepEqual(event.callSites[0].payloadReads, []);
  assert.ok(contract.bootContract.inputRegistration.includes(event.name));
  const site = event.callSites[0];
  const source = fs.readFileSync(path.join(assetDirectory, site.file), 'utf8').slice(...site.charRange);
  assert.equal(source, site.source);
  const callback = parse(source, { ecmaVersion: 'latest' }).body[0].expression.arguments[1];
  const expression = callback.body.body[0].expression;
  assert.equal(expression.operator, '||');
  assert.equal(expression.left.operator, '||');
  const [count, feedback] = expression.right.expressions;
  assert.equal(count.callee.property.name, 'incrementLocalClickCount');
  for (const [firstGuard, secondGuard, expected] of [[false, false, 1], [true, false, 0], [false, true, 0], [true, true, 0]]) {
    let counts = 0, claps = 0;
    const handler = vm.runInNewContext(source, {
      [site.callee]: (name, listener) => { assert.equal(name, event.name); return listener; },
      [expression.left.left.callee.name]: () => firstGuard,
      [expression.left.right.name]: secondGuard,
      [count.callee.object.name]: { incrementLocalClickCount() { counts += 1; } },
      [feedback.callee.name]: () => { claps += 1; },
    });
    handler();
    assert.equal(counts, expected);
    assert.equal(claps, expected);
  }
});

test('storage retains account/environment identity and intentional zero counts', () => {
  const find = name => contract.commands.find(item => item.name === name);
  assert.equal(contract.runtimeConstants.clickCacheEnvironment, profile.id === 'cn' ? 'cn-cn-prod' : 'global-global-prod');
  assert.equal(find('load_key_press_count').response.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(find('save_key_press_count').request.properties.count.minimum, 0);
  assert.deepEqual(Object.keys(find('load_cumulative_click_count').response.properties).sort(), ['count', 'cuid', 'environment']);
  assert.equal(find('save_cumulative_click_count').request.properties.environment.value, contract.runtimeConstants.clickCacheEnvironment);
});

test('settings and monitor events preserve their object payload envelopes', () => {
  const find = name => contract.events.find(item => item.name === name).payload;
  assert.equal(find('cat-settings-passthrough').properties.enabled.type, 'boolean');
  assert.equal(find('cat-settings-pet-scale-drag').properties.active.type, 'boolean');
  assert.equal(find('cat-settings-opacity').properties.opacityPercent.type, 'number');
  assert.equal(find('cat-settings-pet-scale').properties.petScale.type, 'number');
  assert.equal(find('cat-main-monitor-switch-layout-request').properties.targetWidth.type, 'number');
  assert.equal(contract.bootContract.routes.toast, '/toast');
});

test('AST inventory resolves short imports and dynamic destructuring without following shadowed names', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wuwa-contract-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'core.js'), `
      function invoke(command, args) { return window.__TAURI_INTERNALS__.invoke(command, args); }
      function listen(name, handler) { return invoke('plugin:event|listen', { event: name, handler }); }
      const INPUT_EVENT = 'mouse-move';
      export { invoke as aX, listen as b9, INPUT_EVENT as M };
    `);
    const application = `
      import { aX as k, b9 as l, M as eventName } from './core.js';
      const APP_REGION = 'CN';
      const APP_DISPLAY_NAME = 'Wuwa Tappo';
      function normalizeClickCacheEnvironmentPart(value, fallback) {
        return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || fallback;
      }
      const CLICK_CACHE_ENVIRONMENT = \`\${APP_REGION.toLowerCase()}-\${normalizeClickCacheEnvironmentPart('cn-prod', 'unknown')}\`;
      const DEFAULT_DESKTOP_CAT_SETTINGS = { position: 'bottomRight' };
      const router = createRouter({ routes: [
        { path: '/', name: 'main', component: () => import('./core.js') },
        { path: '/installer', name: 'installer', component: () => import('./installer-renamed.js') }
      ] });
      const note = '中文';
      k('load_key_press_count', { environment: CLICK_CACHE_ENVIRONMENT });
      l(eventName, event => { console.log(event.payload.x, event.payload.memberId); });
      function unrelated(k) { k('not_a_native_command'); }
      async function lazilyImported() {
        const { invoke: short } = await import('./core.js');
        await short('get_boot_diagnostics');
      }
    `;
    fs.writeFileSync(path.join(directory, 'app.js'), application);
    fs.writeFileSync(path.join(directory, 'installer-renamed.js'), `
      import { aX as native } from './core.js';
      native('start_silent_nsis_install', { payload: {} });
    `);
    const inventory = inventoryAssets(directory);
    assert.equal(inventory.sourceApplication.region, 'CN');
    assert.equal(inventory.sourceApplication.entryModule, 'app.js');
    assert.equal(inventory.runtimeConstants.clickCacheEnvironment, 'cn-cn-prod');
    assert.deepEqual(inventory.commands.find(item => item.name === 'start_silent_nsis_install').scopes, ['windows-installer']);
    assert.ok(inventory.commands.some(item => item.name === 'load_key_press_count'));
    assert.ok(inventory.commands.some(item => item.name === 'get_boot_diagnostics'));
    assert.ok(!inventory.commands.some(item => item.name === 'not_a_native_command'));
    const event = inventory.events.find(item => item.name === 'mouse-move');
    assert.deepEqual(event.callSites[0].payloadReads, ['', 'memberId', 'x']);
    const site = inventory.commands.find(item => item.name === 'load_key_press_count').callSites[0];
    assert.equal(application.slice(...site.charRange), site.source);
    assert.equal(Buffer.from(application).subarray(...site.byteRange).toString(), site.source);
    assert.notEqual(site.byteRange[0], site.charRange[0]);
    const globalApplication = application.replace("APP_REGION = 'CN'", "APP_REGION = 'GLOBAL'").replace("'cn-prod'", "'global-prod'");
    fs.writeFileSync(path.join(directory, 'app.js'), globalApplication);
    const globalInventory = inventoryAssets(directory);
    assert.equal(globalInventory.runtimeConstants.clickCacheEnvironment, 'global-global-prod');
    assert.equal(globalInventory.commands.find(item => item.name === 'load_key_press_count').request.properties.environment.value, 'global-global-prod');
    assert.equal(inventory.commands.find(item => item.name === 'load_key_press_count').request.properties.environment.value, 'cn-cn-prod');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
