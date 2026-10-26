(function initializeMacSession(initial) {
  'use strict';

  const localApp = (location.protocol === 'tauri:' && location.hostname === 'localhost')
    || (['http:', 'https:'].includes(location.protocol) && ['localhost', '127.0.0.1', 'tauri.localhost'].includes(location.hostname));
  if (!localApp || window.__WUWATAPPO_SESSION__) return;

  const secureKeys = new Set(['__KrSDK_USER_TOKEN__', '__KrSDK_USER_INFO__', 'overseas-pending-role-select']);
  const persistence = initial.persistence ?? 'keychain';
  const originalStorage = window.localStorage;
  const rawGet = originalStorage.getItem.bind(originalStorage);
  const rawSet = originalStorage.setItem.bind(originalStorage);
  const rawRemove = originalStorage.removeItem.bind(originalStorage);
  const rawClear = originalStorage.clear.bind(originalStorage);
  const rawKey = originalStorage.key.bind(originalStorage);
  const pending = [];
  let durable = initial;
  let current;
  let writer = null;
  let failure = null;
  let connectionFailed = false;
  let ready;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function cookieKey(cookie) { return `${cookie.path}\u0000${cookie.name}`; }
  function alive(cookie) { return cookie.expiresAt === null || cookie.expiresAt > Date.now(); }

  function apply(snapshot, mutation) {
    if (mutation.kind === 'set_cookie') {
      const key = cookieKey(mutation.cookie);
      snapshot.cookies = snapshot.cookies.filter((cookie) => cookieKey(cookie) !== key && alive(cookie));
      if (alive(mutation.cookie)) snapshot.cookies.push(clone(mutation.cookie));
    } else if (mutation.kind === 'set_storage') {
      if (mutation.value === null) delete snapshot.storage[mutation.key];
      else snapshot.storage[mutation.key] = mutation.value;
    } else if (mutation.kind === 'clear_storage') snapshot.storage = {};
  }

  function recalculate() {
    current = clone(durable);
    for (const mutation of pending) apply(current, mutation);
  }

  function acceptSnapshot(snapshot) {
    if (!snapshot || snapshot.revision < durable.revision) return;
    const previous = current?.storage ?? {};
    durable = snapshot;
    recalculate();
    for (const key of secureKeys) {
      const oldValue = previous[key] ?? null;
      const newValue = current.storage[key] ?? null;
      if (oldValue !== newValue) window.dispatchEvent(new StorageEvent('storage', {
        key, oldValue, newValue, url: location.href, storageArea: originalStorage,
      }));
    }
  }

  function showFailure() {
    const show = () => {
      if (!failure) return;
      if (document.getElementById('wuwatappo-session-error')) return;
      const banner = document.createElement('div');
      banner.id = 'wuwatappo-session-error';
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;z-index:2147483647;left:16px;right:16px;top:16px;padding:16px;border-radius:12px;background:#fff2e5;color:#5b2400;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0003;pointer-events:auto';
      const text = document.createElement('div');
      text.textContent = persistence === 'memory'
        ? 'Sign-in session could not be synchronized. Retry to continue.'
        : 'Sign-in could not be saved securely. Unlock your login keychain, then retry.';
      const retry = document.createElement('button');
      retry.textContent = persistence === 'memory' ? 'Retry session' : 'Retry saving';
      retry.addEventListener('click', () => { retrySession().catch(showFailure); });
      banner.append(text, retry);
      (document.body || document.documentElement).appendChild(banner);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
    window.dispatchEvent(new CustomEvent('wuwatappo-session-error'));
  }

  function clearFailure() {
    document.getElementById('wuwatappo-session-error')?.remove();
  }

  function rawInvoke(command, payload) {
    if (!window.__TAURI_INTERNALS__?.invoke) return Promise.reject(new Error('App session bridge is unavailable'));
    return window.__TAURI_INTERNALS__.invoke(command, payload);
  }

  function startWriter() {
    if (writer || failure || pending.length === 0) return writer;
    writer = (async () => {
      while (pending.length) {
        try {
          const snapshot = await rawInvoke('session_apply', { mutation: pending[0] });
          pending.shift();
          acceptSnapshot(snapshot);
        } catch {
          failure = new Error(persistence === 'memory'
            ? 'Sign-in could not be updated in this session'
            : 'Sign-in could not be saved securely in Keychain');
          showFailure();
          break;
        }
      }
      if (!failure) clearFailure();
    })().finally(() => { writer = null; });
    return writer;
  }

  function enqueue(mutation) {
    pending.push(mutation);
    recalculate();
    startWriter();
  }

  async function flush() {
    await ready;
    for (;;) {
      if (failure) throw failure;
      const task = startWriter();
      if (!task) return;
      await task;
    }
  }

  function parseCookie(value) {
    const parts = String(value).split(';');
    const pair = parts.shift();
    const equal = pair.indexOf('=');
    if (equal < 1) return null;
    const name = pair.slice(0, equal).trim();
    const cookieValue = pair.slice(equal + 1).trim();
    if (/[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(name) || /[\x00-\x1f\x7f;]/.test(cookieValue)) return null;
    const pathname = location.pathname || '/';
    let path = pathname.slice(0, pathname.lastIndexOf('/')) || '/';
    let expiresAt = null;
    let maxAge;
    let secure = false;
    let sameSite = null;
    for (const attribute of parts) {
      const index = attribute.indexOf('=');
      const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const item = index < 0 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain' && item.replace(/^\./, '').toLowerCase() !== location.hostname.toLowerCase()) return null;
      if (key === 'path' && item.startsWith('/')) path = item;
      if (key === 'expires') { const parsed = Date.parse(item); if (Number.isFinite(parsed)) expiresAt = parsed; }
      if (key === 'max-age' && /^-?\d+$/.test(item)) maxAge = Number(item);
      if (key === 'secure') secure = true;
      if (key === 'samesite' && ['none', 'lax', 'strict'].includes(item.toLowerCase())) sameSite = item.toLowerCase();
      if (key === 'httponly') return null;
    }
    if (sameSite === 'none' && !secure) return null;
    if (maxAge !== undefined) expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
    return { name, value: cookieValue, path, expiresAt, secure, sameSite };
  }

  recalculate();
  Object.defineProperty(document, 'cookie', {
    configurable: false,
    get() {
      const path = location.pathname || '/';
      return current.cookies.filter((cookie) => alive(cookie)
        && (path === cookie.path || (path.startsWith(cookie.path) && (cookie.path.endsWith('/') || path[cookie.path.length] === '/'))))
        .sort((first, second) => second.path.length - first.path.length)
        .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    },
    set(value) { const cookie = parseCookie(value); if (cookie) enqueue({ kind: 'set_cookie', cookie }); },
  });

  function storageKeys() {
    const keys = [];
    for (let index = 0; index < originalStorage.length; index += 1) {
      const key = rawKey(index);
      if (!secureKeys.has(key)) keys.push(key);
    }
    return [...keys, ...Object.keys(current.storage)];
  }

  const methods = {
    getItem(key) { key = String(key); return secureKeys.has(key) ? current.storage[key] ?? null : rawGet(key); },
    setItem(key, value) {
      key = String(key); value = String(value);
      if (secureKeys.has(key)) { rawRemove(key); enqueue({ kind: 'set_storage', key, value }); }
      else rawSet(key, value);
    },
    removeItem(key) {
      key = String(key);
      if (secureKeys.has(key)) { rawRemove(key); enqueue({ kind: 'set_storage', key, value: null }); }
      else rawRemove(key);
    },
    clear() { rawClear(); enqueue({ kind: 'clear_storage' }); },
    key(index) { return storageKeys()[Number(index)] ?? null; },
  };
  const storage = new Proxy(originalStorage, {
    get(target, property) {
      if (Object.hasOwn(methods, property)) return methods[property];
      if (property === 'length') return storageKeys().length;
      if (secureKeys.has(property)) return current.storage[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (secureKeys.has(property)) { methods.setItem(property, value); return true; }
      return Reflect.set(target, property, value, target);
    },
    deleteProperty(target, property) {
      if (secureKeys.has(property)) { methods.removeItem(property); return true; }
      return Reflect.deleteProperty(target, property);
    },
    has(target, property) { return Object.hasOwn(current.storage, property) || Reflect.has(target, property); },
    ownKeys() { return [...new Set([...Reflect.ownKeys(originalStorage).filter((key) => !secureKeys.has(key)), ...Object.keys(current.storage)])]; },
    getOwnPropertyDescriptor(target, property) {
      if (secureKeys.has(property)) return Object.hasOwn(current.storage, property)
        ? { configurable: true, enumerable: true, writable: true, value: current.storage[property] } : undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  Object.defineProperty(window, 'localStorage', { configurable: false, get: () => storage });

  async function connect() {
    try {
      const callback = window.__TAURI_INTERNALS__.transformCallback((event) => acceptSnapshot(event.payload));
      await rawInvoke('plugin:event|listen', { event: 'session://changed', target: { kind: 'Any' }, handler: callback });
      acceptSnapshot(await rawInvoke('session_snapshot'));
      connectionFailed = false;
      if (!failure) clearFailure();
    } catch {
      connectionFailed = true;
      failure = new Error('App secure sign-in synchronization is unavailable');
      showFailure();
    }
  }

  async function retrySession() {
    failure = null;
    if (connectionFailed) { ready = connect(); await ready; }
    startWriter();
    return flush();
  }

  Object.defineProperty(window, '__WUWATAPPO_SESSION__', {
    value: Object.freeze({
      flush,
      retry: retrySession,
      status() { return { revision: durable.revision, pendingWrites: pending.length, failed: failure !== null, persistence }; },
    }),
  });
  ready = connect();
})(__WUWATAPPO_SESSION_SNAPSHOT__);
