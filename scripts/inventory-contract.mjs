import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getRegionProfile } from './regions.mjs';

const require = createRequire(import.meta.url);
const { parse } = require(process.env.WUWA_ACORN_PATH || 'acorn');
const unknown = Symbol('unknown');
const roles = new Set(['invoke', 'invoke$1', 'listen', 'listen$1', 'once', 'emit', 'emitTo']);
const number = { type: 'number' }, string = { type: 'string' }, boolean = { type: 'boolean' };
const optional = schema => ({ ...schema, optional: true });
const object = properties => ({ type: 'object', properties });
const insets = object({ left: number, top: number, right: number, bottom: number });
const region = object({ left: number, top: number, width: number, height: number, memberId: optional(number) });
const clickCount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function commandContractsFor(clickCacheEnvironment) {
  const environment = { type: 'string', value: clickCacheEnvironment };
  return {
    apply_main_window_position: { request: object({ payload: object({ alwaysOnTop: boolean, position: { type: 'string', enum: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] }, applyPosition: boolean }) }) },
    check_app_update: {
      request: object({ endpoint: string }), response: { anyOf: [{ type: 'null' }, object({ rid: number, currentVersion: string, version: string, date: optional(string), body: optional(string), rawJson: { type: 'object' } })] },
      notes: 'A non-null result must be a real updater resource; the frontend constructs Update and uses rid with plugin:updater commands.',
    },
    get_app_update_detail: { response: { anyOf: [{ type: 'null' }, { type: 'object', required: ['newVersion'] }] } },
    get_boot_diagnostics: { response: object({ system: optional({ type: 'object' }), runtime: optional({ type: 'object' }), cpu: optional({ type: 'object' }), memory: optional({ type: 'object' }), gpus: optional({ type: 'array' }), display_names: optional({ type: 'array' }) }) },
    get_installed_app_locale: { request: object({ domestic: boolean }), response: string },
    get_installer_launch_mode: { response: object({ otaUpdate: boolean }) },
    get_main_desktop_safe_area: { response: object({ insets, autoHideEdge: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['left', 'top', 'right', 'bottom'] }] }, foregroundFullscreen: boolean }) },
    get_main_taskbar_insets: { response: insets },
    get_maintenance_notice_payload: { response: { anyOf: [{ type: 'null' }, { type: 'object' }] } },
    get_preferred_system_ui_languages: { response: { type: 'array', items: string } },
    get_silent_nsis_status: { response: object({ phase: string, message: string, percent: number }) },
    get_silent_nsis_uninstall_status: { response: object({ phase: string, message: string, percent: number }) },
    get_track_os_info: { response: object({ os: string, osVersion: string }) },
    has_maintenance_notice: { response: boolean },
    inspect_install_directory: { request: object({ payload: object({ installPath: string }) }), response: object({ hasExistingInstallation: boolean }) },
    is_devtools_hotkeys_build: { response: boolean },
    is_elevated_autostart_enabled: { response: boolean },
    is_force_update_locked: { response: boolean },
    is_installed_app_running: { response: boolean },
    is_internal_testing_build: { response: boolean },
    launch_installed_app: { request: object({ locale: string }) },
    load_cumulative_click_count: { request: object({ environment }), response: object({ count: clickCount, cuid: string, environment }), notes: 'Frontend discards records whose environment differs. It compares cuid before reconciling a different account.' },
    load_key_press_count: { request: object({ environment }), response: clickCount },
    open_login_window: { request: object({ intent: { type: 'string', default: 'login' }, compact: boolean }) },
    open_maintenance_notice: { request: object({ payload: { anyOf: [{ type: 'null' }, { type: 'object' }] } }) },
    open_panel_window: { request: object({ payload: object({ tab: { anyOf: [{ type: 'null' }, string] } }) }) },
    open_update_window: { request: object({ detail: { type: 'object' } }) },
    popup_main_dock_context_menu: { request: object({ x: number, y: number }), notes: 'Coordinates supplied by mouse contextmenu handler are local webview CSS pixels.' },
    resize_login_window_to_content: { request: object({ payload: object({ width: number, height: number }) }) },
    save_cumulative_click_count: { request: object({ count: clickCount, cuid: string, environment }) },
    save_key_press_count: { request: object({ count: clickCount, environment }), notes: 'Zero is intentional: force persistence is used when clearing pending clicks after successful report or account reconciliation.' },
    set_elevated_autostart: { request: object({ enabled: boolean }) },
    set_main_force_cursor_ignore: { request: object({ enabled: boolean }) },
    set_main_hit_region: { request: object({ payload: object({ regions: { type: 'array', items: region }, inputRegions: { type: 'array', items: region }, updateNativeInput: boolean, windowPassthrough: boolean, nativeInput: boolean }) }), notes: 'Regions are webview CSS pixels. memberId is numeric and must retain its type for strict room-member comparisons.' },
    set_main_swallow_mouse: { request: object({ enabled: boolean }) },
    set_main_window_content_bounds: { request: object({ payload: object({ width: number, height: number, x: optional(number), y: optional(number), skipPassthroughRefresh: boolean }) }) },
    set_main_window_monitor_bounds: { request: object({ payload: object({ x: number, y: number, width: number, height: number }) }), notes: 'Payload comes from Tauri monitor.position/size and therefore uses physical pixels.' },
    set_native_input_cursor: { request: object({ kind: string }) },
    set_overlay_cursor: { request: object({ kind: string }) },
    set_panel_window_collapsed: { request: object({ payload: object({ collapsed: boolean }) }) },
    start_silent_nsis_install: { request: object({ payload: { type: 'object' } }) },
    start_silent_nsis_uninstall: { request: object({ payload: object({ deleteUserData: boolean }) }) },
    sync_native_menu: { request: object({ labels: object(Object.fromEntries(['openBag', 'openAtlas', 'openExchange', 'openRoom', 'hidePet', 'showPet', 'trayOpenSettings', 'dockSettings', 'windowSize', 'windowPassthrough', 'windowOpacity', 'restart', 'quit', 'trayTooltip'].map(key => [key, string]))), petDockVisible: boolean, petScale: number, windowOpacity: number, windowPassthrough: boolean }) },
    write_app_log: { request: object({ level: string, message: string }) },
  };
}

const nativeEventContracts = {
  'key-press': { payload: string, notes: 'Keyboard only. Preserve the same key string for release; literal space is " ". Repeated press is deduplicated by a Set.' },
  'key-release': { payload: string, notes: 'One matched keyboard release increments local click count. Do not emit mouse buttons on this stream.' },
  'mouse-move': { payload: object({ x: number, y: number, memberId: optional(number) }), notes: 'Global physical screen pixels. Frontend subtracts Tauri innerPosition and divides by scaleFactor.' },
  'mouse-button': { payload: object({ button: { type: 'string', enum: ['left', 'right', 'middle'] }, action: { type: 'string', enum: ['press', 'release'] }, memberId: optional(number) }), notes: 'Press increments local click count. Do not also emit key-press/release or global-clap-mouse for the same click.' },
  'global-clap-mouse': { payload: { type: 'undefined' }, notes: 'Alternative clap-only mouse path. Emitting this alongside mouse-button duplicates click counts.' },
  'deep-link://new-url': { payload: { type: 'array', items: string }, notes: 'Global OAuth expects wuwa-buddy:// callback URLs; preserve URL query parameters for frontend state validation.' },
  'cat-native-network-status-changed': { payload: object({ internetAccess: boolean }) },
  'cat-force-update-lock': { payload: boolean },
  'cat-login-overlay': { payload: object({ open: boolean }) },
  'dock-open-panel': { payload: string },
  'panel-open-tab': { payload: string },
  'tray-set-pet-scale': { payload: number },
  'tray-set-window-opacity': { payload: number },
  'cat-main-window-layout': { payload: object({ reason: optional(string) }) },
  'cat-main-monitor-switch-layout-request': { payload: object({ requestId: string, targetFingerprint: string, targetWidth: number, targetHeight: number }) },
  'cat-main-monitor-switch-layout-done': { payload: object({ requestId: string }) },
  'cat-main-monitor-switch-prepare-request': { payload: object({ requestId: string, sourceFingerprint: { anyOf: [{ type: 'null' }, string] }, targetFingerprint: string }) },
  'cat-main-monitor-switch-prepare-done': { payload: object({ requestId: string }) },
};
for (const name of ['cat-settings-always-show-chest', 'cat-settings-game-mode', 'cat-settings-hover-auto-hide', 'cat-settings-passthrough']) nativeEventContracts[name] = { payload: object({ enabled: boolean }) };
nativeEventContracts['cat-settings-pet-scale-drag'] = { payload: object({ active: boolean }) };
nativeEventContracts['cat-settings-opacity'] = { payload: object({ opacityPercent: number }) };
nativeEventContracts['cat-settings-pet-scale'] = { payload: object({ petScale: number }) };
nativeEventContracts['cat-settings-locale'] = { payload: object({ locale: string }) };
for (const name of ['about-open', 'oss-notice-open', 'tray-quit', 'tray-restart', 'tray-toggle-pet-visibility', 'tray-toggle-window-passthrough', 'update-modal-open', 'cat-auth-login-success', 'cat-auth-logout', 'cat-panel-window-closed', 'cat-panel-request-login', 'cat-persist-clicks-before-exit', 'cat-persist-clicks-done', 'cat-flush-clicks-before-logout', 'cat-flush-clicks-done', 'cat-disconnect-socket-before-exit', 'cat-disconnect-socket-done']) nativeEventContracts[name] = { payload: { type: 'undefined' } };

function children(node) {
  return Object.values(node).flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => value && typeof value === 'object' && typeof value.type === 'string');
}

function bindPattern(pattern, scope, binding) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, binding);
  else if (pattern.type === 'RestElement') bindPattern(pattern.argument, scope, binding);
  else if (pattern.type === 'AssignmentPattern') bindPattern(pattern.left, scope, binding);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(item => bindPattern(item, scope, binding));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(item => bindPattern(item.value || item.argument, scope, {
    ...binding, accessPath: [...(binding.accessPath || []), item.key?.name ?? item.key?.value],
  }));
}

function buildScopes(ast) {
  const nodeScopes = new WeakMap();
  const parents = new WeakMap();
  const root = { bindings: new Map(), parent: null, kind: 'function' };
  function visit(node, incoming, parent) {
    let scope = incoming;
    if (node.type === 'FunctionDeclaration') bindPattern(node.id, incoming, { type: 'function', node, scope: incoming });
    if (node.type === 'ClassDeclaration') bindPattern(node.id, incoming, { type: 'class', node, scope: incoming });
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      scope = { bindings: new Map(), parent: incoming, kind: 'function' };
      if (node.type === 'FunctionExpression') bindPattern(node.id, scope, { type: 'function', node, scope });
      node.params.forEach(param => bindPattern(param, scope, { type: 'parameter', node: param, scope }));
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'SwitchStatement'].includes(node.type)) {
      scope = { bindings: new Map(), parent: incoming, kind: 'block' };
      if (node.type === 'CatchClause') bindPattern(node.param, scope, { type: 'parameter', node: node.param, scope });
    }
    nodeScopes.set(node, scope);
    if (parent) parents.set(node, parent);
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) bindPattern(specifier.local, scope, {
        type: 'import', source: node.source.value,
        imported: specifier.imported?.name ?? (specifier.type === 'ImportNamespaceSpecifier' ? '*' : 'default'), scope,
      });
    }
    if (node.type === 'VariableDeclaration') {
      let target = scope;
      if (node.kind === 'var') while (target.parent && target.kind !== 'function') target = target.parent;
      for (const declaration of node.declarations) bindPattern(declaration.id, target, {
        type: 'variable', node: declaration.init, declaration, scope,
      });
    }
    for (const child of children(node)) visit(child, scope, node);
  }
  visit(ast, root, null);
  return { root, nodeScopes, parents };
}

function lookup(name, scope) {
  for (let current = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return null;
}

function resolveBindingRole(binding, modules, seen = new Set()) {
  if (!binding || seen.has(binding)) return null;
  seen.add(binding);
  if (binding.type === 'function' && roles.has(binding.node.id?.name)) return binding.node.id.name.replace(/\$1$/, '');
  if (binding.type === 'import') {
    const target = modules.get(path.basename(binding.source));
    return resolveBindingRole(target?.exports.get(binding.imported), modules, seen);
  }
  if (binding.type === 'variable' && binding.node?.type === 'Identifier') {
    return resolveBindingRole(lookup(binding.node.name, binding.scope), modules, seen);
  }
  if (binding.type === 'variable' && binding.accessPath?.length === 1 && roles.has(binding.accessPath[0])) {
    let nativeModule = false;
    function inspect(node) {
      if (!node || nativeModule) return;
      if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
        const target = modules.get(path.basename(node.source.value));
        nativeModule = !!target && [...target.exports.values()].some(value => resolveBindingRole(value, modules, new Set(seen)) === 'invoke');
      }
      for (const child of children(node)) inspect(child);
    }
    inspect(binding.node);
    if (nativeModule) return binding.accessPath[0].replace(/\$1$/, '');
  }
  return null;
}

function staticValue(node, scope, seen = new Set()) {
  if (!node) return unknown;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined;
    let binding = lookup(node.name, scope);
    if (binding?.type === 'import') {
      let root = scope;
      while (root.parent) root = root.parent;
      const imported = root.modules?.get(path.basename(binding.source));
      binding = imported?.exports.get(binding.imported);
    }
    if (binding?.type === 'constant') return binding.value;
    if (binding?.type !== 'variable' || seen.has(binding)) return unknown;
    seen.add(binding);
    return staticValue(binding.node, binding.scope, seen);
  }
  if (node.type === 'UnaryExpression') {
    const argument = staticValue(node.argument, scope, new Set(seen));
    if (node.operator === 'void') return undefined;
    if (argument === unknown) return unknown;
    if (node.operator === '!') return !argument;
    if (node.operator === '-') return -argument;
    if (node.operator === '+') return +argument;
  }
  if (node.type === 'TemplateLiteral') {
    let result = node.quasis[0].value.cooked;
    for (let i = 0; i < node.expressions.length; i++) {
      const value = staticValue(node.expressions[i], scope, new Set(seen));
      if (value === unknown) return unknown;
      result += String(value) + node.quasis[i + 1].value.cooked;
    }
    return result;
  }
  if (node.type === 'BinaryExpression') {
    const left = staticValue(node.left, scope, new Set(seen));
    const right = staticValue(node.right, scope, new Set(seen));
    if (left === unknown || right === unknown) return unknown;
    if (node.operator === '+') return left + right;
    if (node.operator === '===') return left === right;
    if (node.operator === '!==') return left !== right;
  }
  if (node.type === 'LogicalExpression' && node.operator === '||') {
    const left = staticValue(node.left, scope, new Set(seen));
    return left === unknown ? unknown : left || staticValue(node.right, scope, new Set(seen));
  }
  if (node.type === 'CallExpression') {
    const args = node.arguments.map(argument => staticValue(argument, scope, new Set(seen)));
    if (args.some(argument => argument === unknown)) return unknown;
    if (node.callee.type === 'Identifier') {
      if (node.callee.name === 'String' && !lookup('String', scope)) return String(args[0]);
      const binding = lookup(node.callee.name, scope);
      const fn = binding?.type === 'function' ? binding.node : null;
      if (fn?.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement' && fn.params.every(param => param.type === 'Identifier') && !seen.has(binding)) {
        const local = { parent: binding.scope, bindings: new Map(fn.params.map((param, index) => [param.name, { type: 'constant', value: args[index] }])) };
        seen.add(binding);
        return staticValue(fn.body.body[0].argument, local, seen);
      }
    }
    if (node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const value = staticValue(node.callee.object, scope, new Set(seen));
      if (typeof value === 'string') {
        if (node.callee.property.name === 'trim' && args.length === 0) return value.trim();
        if (node.callee.property.name === 'toLowerCase' && args.length === 0) return value.toLowerCase();
        if (node.callee.property.name === 'replace' && args.length === 2 && (typeof args[0] === 'string' || args[0] instanceof RegExp) && typeof args[1] === 'string') return value.replace(args[0], args[1]);
      }
    }
  }
  return unknown;
}

function readApplicationMetadata(modules) {
  const candidates = [...modules.values()].filter(module => module.root.bindings.has('APP_REGION') && module.root.bindings.has('router'));
  if (candidates.length !== 1) throw new Error('Expected one application module containing APP_REGION and router');
  const entry = candidates[0];
  const valueOf = name => staticValue({ type: 'Identifier', name }, entry.root);
  const appRegion = valueOf('APP_REGION');
  const clickCacheEnvironment = valueOf('CLICK_CACHE_ENVIRONMENT');
  if (typeof appRegion !== 'string' || typeof clickCacheEnvironment !== 'string') throw new Error('Cannot statically resolve application region or click-cache environment');
  const router = entry.root.bindings.get('router').node;
  const config = router?.type === 'CallExpression' ? router.arguments[0] : null;
  const routeList = config?.properties?.find(property => property.key?.name === 'routes')?.value;
  if (routeList?.type !== 'ArrayExpression') throw new Error('Expected router routes array');
  const routes = routeList.elements.map(route => {
    const properties = Object.fromEntries(route.properties.map(property => [property.key.name ?? property.key.value, property.value]));
    const imports = [];
    function collectImports(node) {
      if (node.type === 'ImportExpression' && node.source.type === 'Literal') imports.push(path.basename(node.source.value));
      for (const child of children(node)) collectImports(child);
    }
    collectImports(properties.component);
    return { name: staticValue(properties.name, entry.root), path: staticValue(properties.path, entry.root), imports };
  });
  const settings = entry.root.bindings.get('DEFAULT_DESKTOP_CAT_SETTINGS')?.node;
  const defaultPosition = settings?.properties?.find(property => property.key?.name === 'position')?.value;
  return {
    entry, appRegion, clickCacheEnvironment, routes,
    displayName: typeof valueOf('APP_DISPLAY_NAME') === 'string' ? valueOf('APP_DISPLAY_NAME') : null,
    defaultPosition: defaultPosition ? staticValue(defaultPosition, entry.root) : null,
    installerFiles: new Set(routes.filter(route => route.name === 'installer' || route.name === 'uninstaller').flatMap(route => route.imports)),
  };
}

function expressionSchema(node, module, depth = 0) {
  if (!node) return { type: 'undefined' };
  const value = staticValue(node, module.nodeScopes.get(node));
  if (value !== unknown) return value === undefined ? { type: 'undefined' } : {
    type: value === null ? 'null' : typeof value, value,
  };
  if (node.type === 'ObjectExpression') return {
    type: 'object', properties: Object.fromEntries(node.properties.filter(item => item.type === 'Property').map(item => [
      item.key.name ?? item.key.value, expressionSchema(item.value, module, depth + 1),
    ])),
    ...(node.properties.some(item => item.type === 'SpreadElement') ? { additionalProperties: true } : {}),
  };
  if (node.type === 'ArrayExpression') return {
    type: 'array', items: node.elements.map(item => expressionSchema(item, module, depth + 1)),
  };
  return { type: 'expression', source: module.source.slice(node.start, node.end) };
}

function anchor(node, module) {
  const before = module.source.slice(0, node.start);
  let owner = node;
  while (owner && !/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(owner.type)) owner = module.parents.get(owner);
  return {
    file: module.file,
    charRange: [node.start, node.end],
    byteRange: [Buffer.byteLength(before), Buffer.byteLength(module.source.slice(0, node.end))],
    line: before.split('\n').length,
    function: owner?.id?.name ?? null,
    source: module.source.slice(node.start, node.end),
    context: module.source.slice(Math.max(0, node.start - 120), Math.min(module.source.length, node.end + 230)),
  };
}

function payloadReads(callback, module) {
  if (!callback || !/^(FunctionExpression|ArrowFunctionExpression)$/.test(callback.type) || callback.params[0]?.type !== 'Identifier') return [];
  const parameterName = callback.params[0].name;
  const parameterBinding = lookup(parameterName, module.nodeScopes.get(callback.params[0]));
  const reads = new Set();
  function visit(node) {
    if (node.type === 'MemberExpression') {
      const parts = [];
      let current = node;
      while (current.type === 'MemberExpression' || current.type === 'ChainExpression') {
        if (current.type === 'ChainExpression') current = current.expression;
        else {
          parts.unshift(current.computed ? current.property.value : current.property.name);
          current = current.object;
        }
      }
      if (current.type === 'Identifier' && current.name === parameterName && parts[0] === 'payload' && lookup(current.name, module.nodeScopes.get(current)) === parameterBinding) reads.add(parts.slice(1).join('.'));
    }
    for (const child of children(node)) visit(child);
  }
  visit(callback.body);
  return [...reads].sort();
}

export function inventoryAssets(assetDirectory, { version = '1.0.0' } = {}) {
  const modules = new Map();
  for (const file of fs.readdirSync(assetDirectory).filter(file => file.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(assetDirectory, file), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const scopes = buildScopes(ast);
    const module = { file, source, ast, ...scopes, exports: new Map() };
    for (const item of ast.body) if (item.type === 'ExportNamedDeclaration') {
      for (const specifier of item.specifiers) module.exports.set(specifier.exported.name, lookup(specifier.local.name, scopes.root));
    }
    modules.set(file, module);
  }
  for (const module of modules.values()) module.root.modules = modules;
  const metadata = readApplicationMetadata(modules);
  const { installerFiles } = metadata;
  const commandContracts = commandContractsFor(metadata.clickCacheEnvironment);
  const commandMap = new Map(), eventMap = new Map(), dynamic = [], aliases = [];
  for (const module of modules.values()) {
    for (const [name, binding] of module.root.bindings) {
      const role = resolveBindingRole(binding, modules);
      if (role) aliases.push({ file: module.file, name, role });
    }
    function visit(node) {
      if (node.type === 'CallExpression') {
        const scope = module.nodeScopes.get(node);
        const role = node.callee.type === 'Identifier' ? resolveBindingRole(lookup(node.callee.name, scope), modules) : null;
        if (role) {
          const nameIndex = role === 'emitTo' ? 1 : 0;
          const name = staticValue(node.arguments[nameIndex], scope);
          const site = { ...anchor(node, module), callee: node.callee.name, role };
          const command = role === 'invoke';
          if (typeof name === 'string') {
            const targetMap = command ? commandMap : eventMap;
            if (!targetMap.has(name)) targetMap.set(name, command ? {
              name, kind: name.startsWith('plugin:') ? 'plugin' : 'application', scopes: [], callSites: [],
            } : { name, operations: [], callSites: [] });
            const entry = targetMap.get(name);
            site.arguments = expressionSchema(node.arguments[nameIndex + 1], module);
            if (command) {
              const itemScope = installerFiles.has(module.file) ? 'windows-installer' : 'application-runtime';
              if (!entry.scopes.includes(itemScope)) entry.scopes.push(itemScope);
            } else {
              if (!entry.operations.includes(role)) entry.operations.push(role);
              if (role === 'listen' || role === 'once') site.payloadReads = payloadReads(node.arguments[nameIndex + 1], module);
            }
            entry.callSites.push(site);
          } else dynamic.push(site);
        }
      }
      for (const child of children(node)) visit(child);
    }
    visit(module.ast);
  }
  for (const entry of commandMap.values()) {
    if (entry.kind === 'application') Object.assign(entry, { response: { type: 'null', consumption: 'await-only' } }, commandContracts[entry.name] || {});
    else entry.implementation = 'Tauri core or official plugin';
  }
  for (const entry of eventMap.values()) Object.assign(entry, nativeEventContracts[entry.name] || {
    payload: { type: 'opaque', evidence: 'Forwarded between frontend windows; callSites retain producer expression and consumer field reads.' },
  });
  const authCallbackScheme = commandMap.has('plugin:deep-link|get_current') && eventMap.has('deep-link://new-url')
    ? staticValue({ type: 'CallExpression', callee: { type: 'Identifier', name: 'getOverseasAuthScheme' }, arguments: [] }, metadata.entry.root)
    : null;
  const mainModule = metadata.routes.find(route => route.path === '/')?.imports[0];
  return {
    schemaVersion: 1,
    sourceApplication: { name: metadata.displayName, region: metadata.appRegion, entryModule: metadata.entry.file, version, frontend: 'Vue / Tauri 2.10.3' },
    runtimeConstants: {
      clickCacheEnvironment: metadata.clickCacheEnvironment,
      maxSafeClickCount: Number.MAX_SAFE_INTEGER,
      ...(typeof authCallbackScheme === 'string' ? { authCallbackScheme } : {}),
      defaultPosition: metadata.defaultPosition,
      hotkeys: { switchDisplay: ['F8', 'f8'], toggleVisibility: ['F9', 'f9'], secondaryAction: ['F4', 'f4'], devtools: ['F5', 'f5'] },
    },
    bootContract: {
      entry: `index.html -> ${metadata.entry.file} router / -> ${mainModule} onMounted`,
      routes: Object.fromEntries(metadata.routes.map(route => [route.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), route.path])),
      requiredResponses: ['is_internal_testing_build', 'is_devtools_hotkeys_build', 'get_main_desktop_safe_area', 'get_main_taskbar_insets', 'load_key_press_count', 'load_cumulative_click_count'],
      requiredWindowMutations: ['set_main_force_cursor_ignore', 'set_main_window_fullscreen_shell', 'apply_main_window_position', 'set_main_window_content_bounds', 'set_main_hit_region'],
      inputRegistration: ['mouse-move', 'mouse-button', 'global-clap-mouse', 'key-press', 'key-release'],
      auth: 'Frontend preserves official HTTP/Socket.IO account, inventory, rewards, and room protocols. Native backend owns window/event transport, not account emulation.',
    },
    nativeAliases: aliases,
    commands: [...commandMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    events: [...eventMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    dynamicCalls: dynamic.map(site => ({ ...site, category: site.role === 'invoke' ? 'framework-plugin-factory' : 'generic-event-forwarder' })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = getRegionProfile();
  const directory = process.argv[2] || new URL(`../${profile.frontendDir}/assets/`, import.meta.url).pathname;
  const destination = process.argv[3] || new URL(profile.id === 'cn' ? '../tests/contracts.json' : '../tests/contracts-global.json', import.meta.url).pathname;
  const { version } = JSON.parse(fs.readFileSync(new URL(`../${profile.upstreamLock}`, import.meta.url), 'utf8'));
  const inventory = inventoryAssets(directory, { version });
  fs.writeFileSync(destination, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`${inventory.commands.length} commands, ${inventory.events.length} named events, ${inventory.dynamicCalls.length} dynamic call sites -> ${destination}`);
}
