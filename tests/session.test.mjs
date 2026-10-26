import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../scripts/mac-session.js', import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));

class FakeStorage {
  #map = new Map();
  getItem(key) { return this.#map.get(String(key)) ?? null; }
  setItem(key, value) {
    key = String(key); value = String(value);
    this.#map.set(key, value);
    Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
  }
  removeItem(key) { this.#map.delete(String(key)); delete this[String(key)]; }
  clear() { for (const key of this.#map.keys()) delete this[key]; this.#map.clear(); }
  key(index) { return [...this.#map.keys()][index] ?? null; }
  get length() { return this.#map.size; }
}

function nativeBackend(initial = { revision: 0, cookies: [], storage: {}, persistence: 'keychain' }) {
  let snapshot = copy(initial);
  const listeners = [];
  const calls = [];
  let rejectWrite = false;
  let rejectSync = false;
  let writeBarrier = null;
  return {
    calls,
    snapshot: () => copy(snapshot),
    failWrites(value) { rejectWrite = value; },
    failSync(value) { rejectSync = value; },
    holdWrites(promise) { writeBarrier = promise; },
    async invoke(command, payload, callbacks) {
      calls.push({ command, payload });
      if (command === 'plugin:event|listen') {
        if (rejectSync) throw new Error('synthetic listener unavailable');
        listeners.push(callbacks.get(payload.handler)); return listeners.length;
      }
      if (command === 'session_snapshot') return copy(snapshot);
      assert.equal(command, 'session_apply');
      if (writeBarrier) await writeBarrier;
      if (rejectWrite) throw new Error('synthetic keychain locked');
      const mutation = payload.mutation;
      if (mutation.kind === 'set_cookie') {
        const cookie = copy(mutation.cookie);
        snapshot.cookies = snapshot.cookies.filter((item) => item.name !== cookie.name || item.path !== cookie.path);
        if (cookie.expiresAt === null || cookie.expiresAt > Date.now()) snapshot.cookies.push(cookie);
      } else if (mutation.kind === 'set_storage') {
        if (mutation.value === null) delete snapshot.storage[mutation.key];
        else snapshot.storage[mutation.key] = mutation.value;
      } else if (mutation.kind === 'clear_storage') snapshot.storage = {};
      else assert.fail(`Unexpected session mutation ${mutation.kind}`);
      snapshot.revision += 1;
      for (const listener of listeners) listener({ payload: copy(snapshot) });
      return copy(snapshot);
    },
    broadcast(value) { for (const listener of listeners) listener({ payload: copy(value) }); },
  };
}

function webview(native, pathname = '/index.html') {
  const storage = new FakeStorage();
  const elements = new Map();
  const events = [];
  const callbacks = new Map();
  const makeElement = () => ({
    style: {},
    children: [],
    setAttribute() {},
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
    remove() { elements.delete(this.id); },
  });
  const document = {
    readyState: 'complete',
    body: makeElement(),
    documentElement: makeElement(),
    getElementById: (id) => elements.get(id),
    createElement: () => makeElement(),
    addEventListener() {},
  };
  const window = {
    localStorage: storage,
    dispatchEvent(event) { events.push(event); },
    __TAURI_INTERNALS__: {
      invoke: (command, payload) => native.invoke(command, payload, callbacks),
      transformCallback(callback) { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
    },
  };
  const location = { protocol: 'tauri:', hostname: 'localhost', pathname, href: `tauri://localhost${pathname}` };
  const context = vm.createContext({
    window, document, location, console,
    CustomEvent: class { constructor(type, detail) { this.type = type; Object.assign(this, detail); } },
    StorageEvent: class { constructor(type, detail) { this.type = type; Object.assign(this, detail); } },
  });
  vm.runInContext(script.replace('__WUWATAPPO_SESSION_SNAPSHOT__', JSON.stringify(native.snapshot())), context);
  return { window, document, storage, events, elements, location, flush: () => window.__WUWATAPPO_SESSION__.flush() };
}

test('cookie setter immediately serves the original frontend while writes commit securely', async () => {
  const native = nativeBackend();
  const view = webview(native);
  let release;
  native.holdWrites(new Promise((resolve) => { release = resolve; }));
  view.document.cookie = 'kuro_infoToken=synthetic-token; Max-Age=604800; path=/; SameSite=None; Secure';
  assert.equal(view.document.cookie, 'kuro_infoToken=synthetic-token');
  assert.equal(native.snapshot().cookies.length, 0);
  release();
  await view.flush();
  assert.equal(native.snapshot().cookies[0].value, 'synthetic-token');
  assert.equal(native.snapshot().cookies[0].secure, true);
  assert.equal(native.snapshot().cookies[0].sameSite, 'none');
  assert.equal(view.storage.length, 0);
});

test('expiry, deletion, Max-Age precedence, cookie path and duplicate names preserve browser semantics', async () => {
  const native = nativeBackend();
  const view = webview(native, '/nested/item');
  view.document.cookie = 'pet=global; Max-Age=60; Path=/';
  view.document.cookie = 'pet=nested; Max-Age=60; Path=/nested';
  assert.equal(view.document.cookie, 'pet=nested; pet=global');
  view.location.pathname = '/nestedness';
  assert.equal(view.document.cookie, 'pet=global');
  view.location.pathname = '/nested/item';
  view.document.cookie = 'pet=; Path=/nested; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  assert.equal(view.document.cookie, 'pet=global');
  view.document.cookie = 'pet=deleted; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Max-Age=0';
  assert.equal(view.document.cookie, '');
  await view.flush();
  assert.deepEqual(native.snapshot().cookies, []);
});

test('invalid domain, insecure SameSite=None and HttpOnly setters are ignored', async () => {
  const native = nativeBackend();
  const view = webview(native);
  view.document.cookie = 'token=synthetic; Domain=external.example';
  view.document.cookie = 'token=synthetic; SameSite=None';
  view.document.cookie = 'token=synthetic; HttpOnly';
  view.document.cookie = 'invalid name=synthetic';
  await view.flush();
  assert.equal(view.document.cookie, '');
  assert.equal(native.calls.filter((call) => call.command === 'session_apply').length, 0);
});

test('SDK and pending role credentials use Keychain bridge while ordinary settings stay in WebView storage', async () => {
  const native = nativeBackend();
  const view = webview(native);
  const local = view.window.localStorage;
  local.setItem('__KrSDK_USER_TOKEN__', 'synthetic-sdk-value');
  local.setItem('overseas-pending-role-select', JSON.stringify({ loginInfo: { accessToken: 'synthetic' } }));
  local.setItem('ui-scale', '1.25');
  assert.equal(local.getItem('__KrSDK_USER_TOKEN__'), 'synthetic-sdk-value');
  assert.equal(view.storage.getItem('__KrSDK_USER_TOKEN__'), null);
  assert.equal(view.storage.getItem('overseas-pending-role-select'), null);
  assert.equal(view.storage.getItem('ui-scale'), '1.25');
  assert.equal(local.length, 3);
  assert.deepEqual([...Object.keys(local)].sort(), ['__KrSDK_USER_TOKEN__', 'overseas-pending-role-select', 'ui-scale'].sort());
  await view.flush();
  assert.equal(native.snapshot().storage.__KrSDK_USER_TOKEN__, 'synthetic-sdk-value');
  local.removeItem('__KrSDK_USER_TOKEN__');
  await view.flush();
  assert.equal(local.getItem('__KrSDK_USER_TOKEN__'), null);
  local.clear();
  await view.flush();
  assert.equal(local.length, 0);
  assert.deepEqual(native.snapshot().storage, {});
});

test('native events synchronize multiple windows, preserve concurrent pending changes, and ignore old revisions', async () => {
  const native = nativeBackend();
  const first = webview(native);
  const second = webview(native);
  await Promise.all([first.flush(), second.flush()]);
  first.document.cookie = 'kuro_infoToken=synthetic-a; Path=/; Max-Age=60; Secure; SameSite=None';
  second.window.localStorage.setItem('__KrSDK_USER_INFO__', '{"synthetic":true}');
  await Promise.all([first.flush(), second.flush()]);
  assert.equal(second.document.cookie, 'kuro_infoToken=synthetic-a');
  assert.equal(first.window.localStorage.getItem('__KrSDK_USER_INFO__'), '{"synthetic":true}');
  assert.ok(first.events.some((event) => event.type === 'storage' && event.key === '__KrSDK_USER_INFO__'));
  native.broadcast({ revision: 0, cookies: [], storage: {} });
  assert.equal(second.document.cookie, 'kuro_infoToken=synthetic-a');
  assert.equal(first.window.localStorage.getItem('__KrSDK_USER_INFO__'), '{"synthetic":true}');
});

test('Keychain denial is visible, rejects the barrier, and can be retried without a plaintext fallback', async () => {
  const native = nativeBackend();
  native.failWrites(true);
  const view = webview(native);
  view.window.localStorage.setItem('__KrSDK_USER_TOKEN__', 'synthetic-retry');
  await assert.rejects(view.flush(), /Keychain/);
  assert.ok(view.elements.has('wuwatappo-session-error'));
  assert.equal(view.storage.getItem('__KrSDK_USER_TOKEN__'), null);
  assert.equal(native.snapshot().storage.__KrSDK_USER_TOKEN__, undefined);
  assert.equal(view.window.__WUWATAPPO_SESSION__.status().failed, true);
  native.failWrites(false);
  await view.window.__WUWATAPPO_SESSION__.retry();
  assert.equal(native.snapshot().storage.__KrSDK_USER_TOKEN__, 'synthetic-retry');
  assert.equal(view.elements.has('wuwatappo-session-error'), false);
  assert.equal(view.window.__WUWATAPPO_SESSION__.status().failed, false);
});

test('new windows receive the committed snapshot and a fresh app session can restore it', async () => {
  const native = nativeBackend();
  const first = webview(native);
  first.document.cookie = 'kuro_infoToken=synthetic-restored; Path=/; Max-Age=60; Secure; SameSite=None';
  first.window.localStorage.setItem('overseas-pending-role-select', '{"loginInfo":{"accessToken":"synthetic"}}');
  await first.flush();
  const reopened = webview(nativeBackend(native.snapshot()));
  assert.equal(reopened.document.cookie, 'kuro_infoToken=synthetic-restored');
  assert.equal(reopened.window.localStorage.getItem('overseas-pending-role-select'), '{"loginInfo":{"accessToken":"synthetic"}}');
  await reopened.flush();
});

test('a failed native subscription must reconnect before retry reports success', async () => {
  const native = nativeBackend();
  native.failSync(true);
  const first = webview(native);
  await assert.rejects(first.flush(), /synchronization/);
  assert.equal(first.window.__WUWATAPPO_SESSION__.status().failed, true);
  native.failSync(false);
  await first.window.__WUWATAPPO_SESSION__.retry();
  const second = webview(native);
  await second.flush();
  second.document.cookie = 'probe=synthetic; Path=/; Max-Age=60';
  await second.flush();
  assert.equal(first.document.cookie, 'probe=synthetic');
  assert.equal(first.window.__WUWATAPPO_SESSION__.status().failed, false);
});

test('explicit memory mode retains shared cookie and SDK semantics without plaintext credential storage', async () => {
  const native = nativeBackend({ revision: 0, cookies: [], storage: {}, persistence: 'memory' });
  const main = webview(native);
  const login = webview(native);
  await Promise.all([main.flush(), login.flush()]);
  main.document.cookie = 'kuro_infoToken=synthetic-memory; Path=/; Max-Age=604800; Secure; SameSite=None';
  login.window.localStorage.setItem('__KrSDK_USER_TOKEN__', 'synthetic-sdk-memory');
  login.window.localStorage.setItem('__KrSDK_USER_INFO__', '{"synthetic":true}');
  login.window.localStorage.setItem('overseas-pending-role-select', '{"loginInfo":{"accessToken":"synthetic"}}');
  await Promise.all([main.flush(), login.flush()]);
  assert.equal(login.document.cookie, 'kuro_infoToken=synthetic-memory');
  assert.equal(main.window.localStorage.getItem('__KrSDK_USER_TOKEN__'), 'synthetic-sdk-memory');
  assert.equal(main.window.localStorage.getItem('__KrSDK_USER_INFO__'), '{"synthetic":true}');
  assert.equal(main.window.__WUWATAPPO_SESSION__.status().persistence, 'memory');
  assert.equal(login.window.__WUWATAPPO_SESSION__.status().persistence, 'memory');
  assert.equal(main.storage.getItem('__KrSDK_USER_TOKEN__'), null);
  assert.equal(login.storage.getItem('__KrSDK_USER_TOKEN__'), null);
  assert.equal(login.storage.getItem('__KrSDK_USER_INFO__'), null);
  assert.equal(login.storage.getItem('overseas-pending-role-select'), null);
  main.document.cookie = 'kuro_infoToken=; Path=/; Max-Age=0; Secure; SameSite=None';
  login.window.localStorage.clear();
  await Promise.all([main.flush(), login.flush()]);
  assert.equal(main.document.cookie, '');
  assert.equal(login.window.localStorage.getItem('__KrSDK_USER_TOKEN__'), null);
});

test('a fresh memory-mode app session starts empty rather than restoring the preceding process', async () => {
  const original = webview(nativeBackend({ revision: 0, cookies: [], storage: {}, persistence: 'memory' }));
  original.document.cookie = 'kuro_infoToken=synthetic-do-not-restore; Path=/; Max-Age=60';
  original.window.localStorage.setItem('__KrSDK_USER_TOKEN__', 'synthetic-do-not-restore');
  await original.flush();
  const restarted = webview(nativeBackend({ revision: 0, cookies: [], storage: {}, persistence: 'memory' }));
  await restarted.flush();
  assert.equal(restarted.document.cookie, '');
  assert.equal(restarted.window.localStorage.getItem('__KrSDK_USER_TOKEN__'), null);
  assert.equal(restarted.window.__WUWATAPPO_SESSION__.status().revision, 0);
  assert.equal(restarted.window.__WUWATAPPO_SESSION__.status().persistence, 'memory');
});

test('memory-mode synchronization errors do not ask for Keychain authorization or switch modes', async () => {
  const native = nativeBackend({ revision: 0, cookies: [], storage: {}, persistence: 'memory' });
  native.failWrites(true);
  const view = webview(native);
  view.window.localStorage.setItem('__KrSDK_USER_TOKEN__', 'synthetic-memory-retry');
  await assert.rejects(view.flush(), /this session/);
  const error = view.elements.get('wuwatappo-session-error');
  assert.ok(error);
  assert.ok(!error.children[0].textContent.includes('keychain'));
  assert.equal(error.children[1].textContent, 'Retry session');
  assert.equal(view.window.__WUWATAPPO_SESSION__.status().persistence, 'memory');
  assert.equal(view.storage.getItem('__KrSDK_USER_TOKEN__'), null);
  native.failWrites(false);
  await view.window.__WUWATAPPO_SESSION__.retry();
  assert.equal(view.window.localStorage.getItem('__KrSDK_USER_TOKEN__'), 'synthetic-memory-retry');
  assert.equal(view.window.__WUWATAPPO_SESSION__.status().persistence, 'memory');
});
