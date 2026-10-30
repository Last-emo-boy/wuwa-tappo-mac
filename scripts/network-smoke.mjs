import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { getRegionProfile } from './regions.mjs';

const profile = getRegionProfile();
const contractUrl = new URL(`../tests/network-contract${profile.id === 'global' ? '-global' : ''}.json`, import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
export const contract = JSON.parse(await readFile(contractUrl, 'utf8'));

export function verifyDomesticSdkAssetBinding(main, loginView) {
  const exports = new Map();
  for (const node of parse(main, { sourceType: 'module', ecmaVersion: 'latest' }).body) {
    if (node.type === 'ExportNamedDeclaration') {
      for (const item of node.specifiers) exports.set(item.local.name, item.exported.name);
    }
  }
  const tree = parse(loginView, { sourceType: 'module', ecmaVersion: 'latest' });
  const imports = new Map();
  for (const node of tree.body) {
    if (node.type === 'ImportDeclaration' && node.source.value === `./${contract.source.main}`) {
      for (const item of node.specifiers) if (item.type === 'ImportSpecifier') imports.set(item.imported.name, item.local.name);
    }
  }
  const [head, script, stylesheet] = ['useHead', 'isdkSrc', 'isdkCss'].map(name => imports.get(exports.get(name)));
  assert.ok(head && script && stylesheet, 'Login view must import the official SDK asset bindings');
  const calls = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === head) calls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  assert.equal(calls.length, 1, 'Login view must load the embedded SDK assets exactly once');
  const properties = node => new Map((node?.type === 'ObjectExpression' ? node.properties : []).map(item => [item.key?.name ?? item.key?.value, item.value]));
  const assets = properties(calls[0].arguments[0]);
  const links = assets.get('link'), scripts = assets.get('script');
  assert.ok(links?.type === 'ArrayExpression' && scripts?.type === 'ArrayExpression', 'Login view must declare both SDK stylesheet and script');
  assert.equal(links.elements.length, 1);
  assert.equal(scripts.elements.length, 1);
  const link = properties(links.elements[0]), loader = properties(scripts.elements[0]);
  assert.equal(link.get('rel')?.value, 'stylesheet');
  assert.equal(link.get('href')?.type, 'Identifier');
  assert.equal(link.get('href')?.name, stylesheet, 'Login stylesheet must use the official SDK binding');
  assert.equal(loader.get('src')?.type, 'Identifier');
  assert.equal(loader.get('src')?.name, script, 'Login script must use the official SDK binding');
}

export function verifyGlobalCallbackBridge(source, { prepared = false } = {}) {
  const current = 'async function getCurrent(){return await invoke("plugin:deep-link|get_current")}';
  const official = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
  const privateWake = 'async function onOpenUrl(e){return await listen("mac-oauth-callback-ready",()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))})}';
  assert.equal(source.split(current).length, 2, 'Global OAuth callbacks must be read through the native get_current command');
  if (prepared) {
    assert.equal(source.split(privateWake).length, 2, 'Prepared Global OAuth must use the private callback-ready wake and get_current read');
    assert.ok(!source.includes('"deep-link://new-url"'), 'Prepared Global OAuth must not receive credential-bearing URL event payloads');
    return 'private-command-after-wake';
  }
  assert.equal(source.split(official).length, 2, 'Official Global OAuth event bridge changed');
  assert.ok(!source.includes('"mac-oauth-callback-ready"'), 'Official Global source unexpectedly contains the Mac callback wake');
  return 'official-url-event';
}

export async function verifySourceContract(assetDirectory = path.join(root, profile.frontendDir, 'assets'), { prepared = false } = {}) {
  const [main, room, login, loginView] = await Promise.all(
    ['main', 'room', 'login', 'loginView'].map((name) => readFile(path.join(assetDirectory, contract.source[name]), 'utf8')),
  );
  const observed = [...main.matchAll(/jsonpClient\.(get|post|put|delete)\("([^"\n]+)"/g)]
    .map((match) => `${match[1].toUpperCase()} /${match[2].replace(/^\/+/, '')}`)
    .sort();
  const expected = contract.http.endpoints.map(({ method, path }) => `${method} ${path}`).sort();
  assert.deepEqual(observed, expected, 'Business endpoint inventory differs from the supplied frontend');
  assert.ok(![main, room, login, loginView].some((source) => source.includes('plugin:http|')), 'Frontend now uses a native HTTP plugin');
  assert.ok(main.includes(`APP_REGION="${contract.region}"`), `Expected the ${contract.region} frontend build`);
  for (const value of [
    contract.http.baseUrl,
    contract.auth.businessTokenCookie.replace(/^kuro_/, ''),
    contract.nativeNetwork.event,
    contract.updater.nativeCheckCommand,
    contract.updater.nativeLockCommand,
    path.posix.basename(contract.updater.indexPath),
  ]) assert.ok(main.includes(value), `Missing frontend network marker: ${value}`);
  for (const value of contract.auth.secureLocalStorageKeys) assert.ok(login.includes(value), `Missing secure login storage marker: ${value}`);
  let sdkUrlsAreExplicitHttps = null;
  let globalOAuthDelivery = null;
  if (contract.auth.mode === 'embedded_dom_sdk') {
    for (const value of [contract.auth.sdk.initMethod, contract.auth.sdk.openMethod, contract.auth.sdk.successEvent, contract.auth.viewOpenedEvent]) {
      assert.ok(login.includes(value), `Missing domestic login marker: ${value}`);
    }
    assert.ok(!login.includes('plugin:deep-link|'), 'Domestic login unexpectedly requires a native OAuth callback');
    assert.ok(/\b_e\(e,1\)/.test(login), 'Domestic player query must pass is_domestic=1');
    assert.ok(/\bse\([^;]+,"sdk",i,a,1\)/.test(login), 'Domestic SDK login must pass source=sdk and is_domestic=1');
    assert.ok(loginView.includes('handleInlandSDKLogin'), 'Login view must bind the domestic SDK callback');
    verifyDomesticSdkAssetBinding(main, loginView);
    const scriptIsHttps = main.includes(`isdkSrc="${contract.auth.sdk.scriptUrl}"`);
    const stylesheetIsHttps = main.includes(`isdkCss="${contract.auth.sdk.stylesheetUrl}"`);
    assert.ok(scriptIsHttps || main.includes(`isdkSrc="${contract.auth.sdk.sourceScriptUrl}"`), 'Unexpected domestic SDK script URL');
    assert.ok(stylesheetIsHttps || main.includes(`isdkCss="${contract.auth.sdk.sourceStylesheetUrl}"`), 'Unexpected domestic SDK stylesheet URL');
    sdkUrlsAreExplicitHttps = scriptIsHttps && stylesheetIsHttps;
  } else {
    assert.equal(contract.auth.mode, 'browser_oauth');
    for (const value of [
      contract.auth.browser.loginUrl,
      `return"${contract.auth.browser.scheme}".trim()`,
      contract.auth.browser.pendingStateKey,
      contract.auth.browser.pendingAtKey,
      'PENDING_TTL_MS=900*1e3',
      'plugin:deep-link|get_current',
      'if(!assertPendingStateMatches(n.state))',
      'function assertPendingStateMatches(e){const t=readPendingState();return t?t===e:!1}',
      'await queryPlayer(e,0)',
      'Login(e.cuid,e.puid,e.channelId,e.userId,e.userName,e.accessToken,"sdk",t,n,0)',
      'await startOverseasBrowserLogin({lang:t})',
    ]) assert.ok(login.includes(value), `Missing global OAuth contract marker: ${value}`);
    globalOAuthDelivery = verifyGlobalCallbackBridge(login, { prepared });
    assert.ok(loginView.includes('handleForeignSDKLogin'), 'Global login view must bind the browser OAuth entry point');
  }
  assert.ok(room.includes(contract.socket.baseUrl), 'Socket host must use the selected regional backend');
  assert.ok(room.includes('transports:["websocket"]'), 'Expected browser WebSocket transport');
  assert.ok(room.includes('reconnection:!1'), 'Expected frontend-owned reconnection');
  return {
    region: contract.region,
    businessEndpoints: observed.length,
    tauriHttpPluginUsed: false,
    loginMode: contract.auth.mode,
    browserOAuthRequired: contract.auth.browserOAuthRequired,
    sdkUrlsAreExplicitHttps,
    globalOAuthDelivery,
    sessionSelection: contract.session.selection,
    requestedSessionPersistence: contract.session.requestedPersistence,
  };
}

function publicAssetUrl(value) {
  const url = new URL(value);
  assert.equal(url.origin, contract.assets.publicHost, 'Static index redirected to an unexpected origin');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  return url;
}

async function publicJson(url, origin, checks) {
  const response = await fetch(url, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  assert.equal(response.status, 200, `Public JSON request failed: ${new URL(url).pathname}`);
  const allowOrigin = response.headers.get('access-control-allow-origin');
  assert.ok(allowOrigin === origin || allowOrigin === '*', 'Public JSON CORS does not allow the app origin');
  const body = await response.json();
  checks.push({ path: new URL(url).pathname, status: response.status, allowOrigin });
  return { response, body };
}

export async function probePublicNetwork() {
  const checks = [];
  let config;
  for (const origin of contract.http.webviewOrigins) {
    const result = await publicJson(`${contract.http.baseUrl}${contract.http.publicConfigPath}`, origin, checks);
    assert.equal(result.body.code, 0);
    assert.equal(result.response.headers.get('access-control-allow-origin'), origin);
    assert.equal(result.response.headers.get('access-control-allow-credentials'), 'true');
    config = result.body.data;
  }
  assert.equal(config.assets_host, contract.assets.publicHost);
  assert.ok(Number.isFinite(config.server_time));
  const origin = 'tauri://localhost';
  const preflight = await fetch(`${contract.http.baseUrl}${contract.http.publicConfigPath}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': contract.http.requestHeaders.join(','),
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const allowHeaders = preflight.headers.get('access-control-allow-headers').toLowerCase().split(',').map((value) => value.trim());
  for (const header of contract.http.requestHeaders) assert.ok(allowHeaders.includes(header.toLowerCase()));
  checks.push({ path: contract.http.publicConfigPath, method: 'OPTIONS', status: preflight.status });

  const { body: appearanceIndex } = await publicJson(`${config.assets_host}${contract.assets.appearanceIndexPath}`, origin, checks);
  const { body: appearance } = await publicJson(publicAssetUrl(appearanceIndex.url), origin, checks);
  const catalogCounts = {};
  for (const type of contract.assets.appearanceTypes) {
    assert.ok(appearance[type] && typeof appearance[type] === 'object');
    catalogCounts[type] = Object.keys(appearance[type]).length;
    assert.ok(catalogCounts[type] > 0);
  }

  const { body: dictionaryIndex } = await publicJson(`${config.assets_host}${contract.assets.dictionaryIndexPath}`, origin, checks);
  const { body: dictionary } = await publicJson(publicAssetUrl(dictionaryIndex.url[contract.assets.initialLocale]), origin, checks);
  assert.ok(dictionary.web && dictionary.character);

  const { body: updateIndex } = await publicJson(`${config.assets_host}${contract.updater.indexPath}`, origin, checks);
  const { body: update } = await publicJson(publicAssetUrl(updateIndex.url), origin, checks);
  assert.equal(typeof update.version, 'string');
  assert.ok(update.platforms && typeof update.platforms === 'object');

  if (contract.auth.mode === 'embedded_dom_sdk') {
    const sdk = await fetch(contract.auth.sdk.scriptUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.equal(sdk.status, 200);
    const sdkSource = await sdk.text();
    assert.ok(sdkSource.includes('openLoginView'));
    assert.ok(sdkSource.includes(contract.auth.sdk.environment));
    checks.push({ path: new URL(contract.auth.sdk.scriptUrl).pathname, service: 'domestic-login-sdk-static-source', status: sdk.status });
  } else {
    const login = await fetch(contract.auth.browser.loginUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-type'), /text\/html/);
    checks.push({ path: new URL(contract.auth.browser.loginUrl).pathname, service: 'global-browser-login-page', status: login.status });
  }

  return {
    region: contract.region,
    checkedAt: new Date().toISOString(),
    checks,
    catalogCounts,
    update: { version: update.version, platforms: Object.keys(update.platforms) },
    authenticatedFeaturesTested: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = await verifySourceContract(process.argv.find((value) => value.startsWith('--assets='))?.slice('--assets='.length), { prepared: process.argv.includes('--prepared') });
    const result = process.argv.includes('--offline') ? { source } : { source, network: await probePublicNetwork() };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
