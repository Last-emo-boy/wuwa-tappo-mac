import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contractUrl = new URL('../tests/network-contract.json', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
export const contract = JSON.parse(await readFile(contractUrl, 'utf8'));

export async function verifySourceContract(assetDirectory = path.join(root, 'frontend/assets')) {
  const [main, room, login, loginView] = await Promise.all(
    ['main', 'room', 'login', 'loginView'].map((name) => readFile(path.join(assetDirectory, contract.source[name]), 'utf8')),
  );
  const observed = [...main.matchAll(/jsonpClient\.(get|post|put|delete)\("([^"\n]+)"/g)]
    .map((match) => `${match[1].toUpperCase()} /${match[2].replace(/^\/+/, '')}`)
    .sort();
  const expected = contract.http.endpoints.map(({ method, path }) => `${method} ${path}`).sort();
  assert.deepEqual(observed, expected, 'Business endpoint inventory differs from the supplied frontend');
  assert.ok(![main, room, login, loginView].some((source) => source.includes('plugin:http|')), 'Frontend now uses a native HTTP plugin');
  assert.ok(main.includes(`APP_REGION="${contract.region}"`), 'Expected the domestic frontend build');
  for (const value of [
    contract.http.baseUrl,
    contract.auth.businessTokenCookie.replace(/^kuro_/, ''),
    contract.nativeNetwork.event,
    contract.updater.nativeCheckCommand,
    contract.updater.nativeLockCommand,
    path.posix.basename(contract.updater.indexPath),
  ]) assert.ok(main.includes(value), `Missing frontend network marker: ${value}`);
  for (const value of [
    contract.auth.sdk.initMethod,
    contract.auth.sdk.openMethod,
    contract.auth.sdk.successEvent,
    contract.auth.viewOpenedEvent,
    ...contract.auth.secureLocalStorageKeys,
  ]) assert.ok(login.includes(value), `Missing domestic login marker: ${value}`);
  assert.ok(!login.includes('plugin:deep-link|'), 'Domestic login unexpectedly requires a native OAuth callback');
  assert.ok(/\b_e\(e,1\)/.test(login), 'Domestic player query must pass is_domestic=1');
  assert.ok(/\bse\([^;]+,"sdk",i,a,1\)/.test(login), 'Domestic SDK login must pass source=sdk and is_domestic=1');
  assert.ok(loginView.includes('handleInlandSDKLogin'), 'Login view must bind the domestic SDK callback');
  assert.ok(loginView.includes('Re({link:'), 'Login view must load the embedded SDK assets');
  const scriptIsHttps = main.includes(`isdkSrc="${contract.auth.sdk.scriptUrl}"`);
  const stylesheetIsHttps = main.includes(`isdkCss="${contract.auth.sdk.stylesheetUrl}"`);
  assert.ok(scriptIsHttps || main.includes(`isdkSrc="${contract.auth.sdk.sourceScriptUrl}"`), 'Unexpected domestic SDK script URL');
  assert.ok(stylesheetIsHttps || main.includes(`isdkCss="${contract.auth.sdk.sourceStylesheetUrl}"`), 'Unexpected domestic SDK stylesheet URL');
  assert.ok(room.includes(contract.socket.baseUrl), 'Socket host must use the domestic backend');
  assert.ok(room.includes('transports:["websocket"]'), 'Expected browser WebSocket transport');
  assert.ok(room.includes('reconnection:!1'), 'Expected frontend-owned reconnection');
  return {
    region: contract.region,
    businessEndpoints: observed.length,
    tauriHttpPluginUsed: false,
    loginMode: contract.auth.mode,
    browserOAuthRequired: false,
    sdkUrlsAreExplicitHttps: scriptIsHttps && stylesheetIsHttps,
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

  const sdk = await fetch(contract.auth.sdk.scriptUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.equal(sdk.status, 200);
  const sdkSource = await sdk.text();
  assert.ok(sdkSource.includes('openLoginView'));
  assert.ok(sdkSource.includes(contract.auth.sdk.environment));
  checks.push({ path: new URL(contract.auth.sdk.scriptUrl).pathname, service: 'domestic-login-sdk-static-source', status: sdk.status });

  return {
    checkedAt: new Date().toISOString(),
    checks,
    catalogCounts,
    update: { version: update.version, platforms: Object.keys(update.platforms) },
    authenticatedFeaturesTested: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = await verifySourceContract(process.argv.find((value) => value.startsWith('--assets='))?.slice('--assets='.length));
    const result = process.argv.includes('--offline') ? { source } : { source, network: await probePublicNetwork() };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
