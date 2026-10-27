(() => {
  'use strict';
  const BrowserWebSocket = window.WebSocket;
  if (!BrowserWebSocket || window.__WUWATAPPO_WEBSOCKET__) return;
  const host = window.__WUWATAPPO_PROFILE__?.socketHost ?? 'api-mc-wuwatappo.kurogames-global.com';
  const viewId = Math.random().toString(36).slice(2);
  let nextId = 0;
  const active = new Set();
  const encoder = new TextEncoder();

  function nativeCore() {
    const read = () => window.__TAURI__?.core;
    if (read()?.Channel && read()?.invoke) return Promise.resolve(read());
    if (document.readyState !== 'loading') return Promise.reject(new Error('Native WebSocket bridge is unavailable'));
    return new Promise((resolve, reject) => document.addEventListener('DOMContentLoaded', () => {
      const core = read();
      if (core?.Channel && core?.invoke) resolve(core);
      else reject(new Error('Native WebSocket bridge is unavailable'));
    }, { once: true }));
  }

  function matches(url) {
    return url.protocol === 'wss:' && url.hostname === host && (!url.port || url.port === '443') && url.pathname === '/socket.io/';
  }

  function protocolsList(value) {
    const values = value === undefined ? [] : typeof value === 'string' ? [value] : Array.from(value);
    const protocols = values.map(String);
    if (new Set(protocols).size !== protocols.length || protocols.some(value => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value))) {
      throw new DOMException('Invalid WebSocket subprotocol', 'SyntaxError');
    }
    return protocols;
  }

  class MacWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    #readyState = 0;
    #binaryType = 'blob';
    #protocol = '';
    #extensions = '';
    #bufferedAmount = 0;
    #url;
    #id;
    #channel;
    #creation;
    #queue;
    #registered = false;
    #handlers = {};

    constructor(value, protocols) {
      super();
      const url = new URL(String(value), location.href);
      if (!matches(url)) return protocols === undefined ? new BrowserWebSocket(value) : new BrowserWebSocket(value, protocols);
      if (url.username || url.password || url.hash) throw new DOMException('Invalid WebSocket URL', 'SyntaxError');
      const selectedProtocols = protocolsList(protocols);
      this.#url = url.href;
      this.#id = `ws-${viewId}-${++nextId}`;
      active.add(this);
      this.#creation = nativeCore().then(core => {
        this.#channel = new core.Channel(event => this.#receive(event));
        return core.invoke('native_ws_connect', { id: this.#id, url: this.#url, protocols: selectedProtocols, events: this.#channel })
          .then(() => { this.#registered = this.#readyState !== 3; });
      });
      this.#queue = this.#creation.catch(() => this.#fail());
    }

    get CONNECTING() { return 0; }
    get OPEN() { return 1; }
    get CLOSING() { return 2; }
    get CLOSED() { return 3; }
    get readyState() { return this.#readyState; }
    get url() { return this.#url; }
    get protocol() { return this.#protocol; }
    get extensions() { return this.#extensions; }
    get bufferedAmount() { return this.#bufferedAmount; }
    get binaryType() { return this.#binaryType; }
    set binaryType(value) { if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value; }

    #setHandler(type, callback) {
      if (this.#handlers[type]) this.removeEventListener(type, this.#handlers[type]);
      this.#handlers[type] = typeof callback === 'function' ? callback : null;
      if (this.#handlers[type]) this.addEventListener(type, this.#handlers[type]);
    }
    get onopen() { return this.#handlers.open ?? null; }
    set onopen(callback) { this.#setHandler('open', callback); }
    get onmessage() { return this.#handlers.message ?? null; }
    set onmessage(callback) { this.#setHandler('message', callback); }
    get onerror() { return this.#handlers.error ?? null; }
    set onerror(callback) { this.#setHandler('error', callback); }
    get onclose() { return this.#handlers.close ?? null; }
    set onclose(callback) { this.#setHandler('close', callback); }

    #receive(event) {
      if (this.#readyState === 3) return;
      if (event.type === 'open') {
        this.#protocol = event.protocol;
        this.#extensions = event.extensions;
        if (this.#readyState === 0) { this.#readyState = 1; this.dispatchEvent(new Event('open')); }
      } else if (event.type === 'text' || event.type === 'binary') {
        if (this.#readyState !== 1) return;
        let data = event.data;
        if (event.type === 'binary') {
          const bytes = new Uint8Array(data);
          data = this.#binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
        }
        this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.#url).origin }));
      } else if (event.type === 'error') {
        // Like browser WebSocket errors, this event contains no request URL or credentials.
        console.warn('[macOS] WebSocket connection failed:', event.message);
        this.dispatchEvent(new Event('error'));
      } else if (event.type === 'close') {
        this.#finish(event.code, event.reason, event.wasClean);
      }
    }

    #finish(code, reason, wasClean) {
      if (this.#readyState === 3) return;
      this.#readyState = 3;
      this.#registered = false;
      active.delete(this);
      this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean }));
      this.#channel?.cleanupCallback?.();
      this.#channel = null;
    }

    #fail() {
      if (this.#readyState === 3) return;
      if (this.#registered) {
        window.__TAURI__.core.invoke('native_ws_close', { id: this.#id, code: 1000, reason: '' })
          .catch(() => console.warn('[macOS] WebSocket cleanup command failed'));
      }
      this.dispatchEvent(new Event('error'));
      this.#finish(1006, '', false);
    }

    send(value) {
      if (this.#readyState === 0) throw new DOMException('WebSocket is still connecting', 'InvalidStateError');
      if (this.#readyState !== 1) return;
      let data;
      let bytes;
      if (value instanceof Blob) {
        bytes = value.size;
        data = () => value.arrayBuffer().then(buffer => ({ type: 'binary', data: Array.from(new Uint8Array(buffer)) }));
      } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const copy = value instanceof ArrayBuffer ? new Uint8Array(value).slice() : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        bytes = copy.byteLength;
        data = () => ({ type: 'binary', data: Array.from(copy) });
      } else {
        const text = String(value);
        bytes = encoder.encode(text).byteLength;
        data = () => ({ type: 'text', data: text });
      }
      this.#bufferedAmount += bytes;
      this.#queue = this.#queue.then(async () => {
        if (this.#readyState === 3) return;
        await window.__TAURI__.core.invoke('native_ws_send', { id: this.#id, data: await data() });
      }).catch(() => this.#fail()).finally(() => { this.#bufferedAmount -= bytes; });
    }

    close(code, reason = '') {
      if (code !== undefined && code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) {
        throw new DOMException('Invalid WebSocket close code', 'InvalidAccessError');
      }
      reason = String(reason);
      if (encoder.encode(reason).byteLength > 123) throw new DOMException('WebSocket close reason is too long', 'SyntaxError');
      if (this.#readyState >= 2) return;
      this.#readyState = 2;
      this.#queue = this.#queue.then(() => {
        if (this.#readyState !== 3) return window.__TAURI__.core.invoke('native_ws_close', { id: this.#id, code, reason });
      }).catch(() => this.#fail());
    }
  }

  window.addEventListener('pagehide', () => { for (const socket of active) socket.close(); });
  Object.defineProperty(window, '__WUWATAPPO_WEBSOCKET__', { value: true });
  window.WebSocket = MacWebSocket;
})();
