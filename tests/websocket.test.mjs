import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../scripts/mac-websocket.js', import.meta.url), 'utf8');
const url = 'wss://api-mc-wuwatappo.kurogames-global.com/socket.io/?EIO=3&transport=websocket&token=synthetic';
const tick = () => new Promise(resolve => setImmediate(resolve));

function environment({ early = false, failConnect = false, failSend = false, profile } = {}) {
  const calls = [];
  const channels = [];
  const warnings = [];
  const pending = [];
  const document = new EventTarget();
  document.readyState = early ? 'loading' : 'complete';
  const window = new EventTarget();
  class BrowserWebSocket {
    constructor(...args) { this.args = args; }
  }
  const core = {
    Channel: class {
      constructor(callback) { this.callback = callback; this.cleaned = false; channels.push(this); }
      cleanupCallback() { this.cleaned = true; }
    },
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'native_ws_connect' && failConnect) throw new Error('synthetic connect rejection');
      if (command === 'native_ws_send' && failSend) throw new Error('synthetic send rejection');
      if (command === 'native_ws_send') await new Promise(resolve => pending.push(resolve));
    },
  };
  window.WebSocket = BrowserWebSocket;
  if (profile) window.__WUWATAPPO_PROFILE__ = profile;
  if (!early) window.__TAURI__ = { core };
  class CloseEvent extends Event {
    constructor(type, init) { super(type); Object.assign(this, init); }
  }
  const context = vm.createContext({
    window, document, location: { href: 'tauri://localhost/index.html' },
    EventTarget, Event, MessageEvent, CloseEvent, DOMException, URL,
    TextEncoder, Blob, ArrayBuffer, Uint8Array,
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(script, context);
  return { window, document, core, BrowserWebSocket, calls, channels, warnings, pending,
    open(index = 0) { channels[index].callback({ type: 'open', protocol: 'sample', extensions: '' }); } };
}

test('only the exact official endpoint uses the native bridge', async () => {
  const env = environment();
  const other = new env.window.WebSocket('wss://example.com/path', ['sample']);
  assert.ok(other instanceof env.BrowserWebSocket);
  assert.deepEqual(other.args, ['wss://example.com/path', ['sample']]);
  for (const value of [url.replace('wss:', 'ws:'), url.replace('/socket.io/', '/other'), url.replace('.com/', '.com:444/')]) {
    assert.ok(new env.window.WebSocket(value) instanceof env.BrowserWebSocket);
  }
  const socket = new env.window.WebSocket(url);
  assert.ok(socket instanceof EventTarget);
  assert.equal(socket.url, url);
  await tick();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].command, 'native_ws_connect');
  assert.equal(env.calls[0].args.url, url);
  assert.equal('headers' in env.calls[0].args, false);
  assert.throws(() => new env.window.WebSocket(`${url}#fragment`), { name: 'SyntaxError' });
  assert.throws(() => new env.window.WebSocket(url, ['duplicate', 'duplicate']), { name: 'SyntaxError' });
  assert.throws(() => new env.window.WebSocket(url, 'invalid,protocol'), { name: 'SyntaxError' });
});

test('open, text and binary events preserve WebSocket state and event handlers', async () => {
  const env = environment();
  const socket = new env.window.WebSocket(url, 'sample');
  assert.equal(socket.readyState, socket.CONNECTING);
  assert.equal(env.window.WebSocket.OPEN, 1);
  assert.throws(() => socket.send('too early'), { name: 'InvalidStateError' });
  const observed = [];
  socket.onopen = () => observed.push('replaced');
  socket.onopen = event => observed.push(event.type);
  socket.addEventListener('open', event => observed.push(`${event.type}-listener`));
  socket.onmessage = event => observed.push(event.data);
  await tick();
  env.open();
  assert.deepEqual(observed, ['open', 'open-listener']);
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(socket.protocol, 'sample');
  assert.equal(socket.extensions, '');
  env.channels[0].callback({ type: 'text', data: 'hello' });
  assert.equal(observed.at(-1), 'hello');
  socket.binaryType = 'arraybuffer';
  env.channels[0].callback({ type: 'binary', data: [1, 2, 3] });
  assert.deepEqual([...new Uint8Array(observed.at(-1))], [1, 2, 3]);
  socket.binaryType = 'ignored';
  assert.equal(socket.binaryType, 'arraybuffer');
  socket.binaryType = 'blob';
  env.channels[0].callback({ type: 'binary', data: [4, 5] });
  assert.ok(observed.at(-1) instanceof Blob);
  assert.deepEqual([...new Uint8Array(await observed.at(-1).arrayBuffer())], [4, 5]);
});

test('send preserves binary snapshots, order and bufferedAmount until native writes finish', async () => {
  const env = environment();
  const socket = new env.window.WebSocket(url);
  await tick(); env.open();
  const bytes = new Uint8Array([9, 1, 2, 8]);
  socket.send('鸣');
  socket.send(bytes.subarray(1, 3));
  bytes[1] = 99;
  socket.send(new Blob([new Uint8Array([3, 4])]));
  socket.send(new Uint8Array([5]).buffer);
  assert.equal(socket.bufferedAmount, 8);
  await tick();
  assert.equal(env.calls.filter(call => call.command === 'native_ws_send').length, 1);
  for (let index = 0; index < 4; index += 1) { env.pending.shift()(); await tick(); }
  const data = env.calls.filter(call => call.command === 'native_ws_send').map(call => JSON.parse(JSON.stringify(call.args.data)));
  assert.deepEqual(data, [
    { type: 'text', data: '鸣' }, { type: 'binary', data: [1, 2] },
    { type: 'binary', data: [3, 4] }, { type: 'binary', data: [5] },
  ]);
  assert.equal(socket.bufferedAmount, 0);
});

test('close validates RFC limits, waits for queued writes and cleans one terminal event', async () => {
  const env = environment();
  const socket = new env.window.WebSocket(url);
  const closed = [];
  socket.onclose = event => closed.push({ code: event.code, reason: event.reason, clean: event.wasClean });
  await tick(); env.open();
  assert.throws(() => socket.close(1006), { name: 'InvalidAccessError' });
  assert.throws(() => socket.close(1000, '鸣'.repeat(42)), { name: 'SyntaxError' });
  socket.send('last');
  socket.close(1000, 'done');
  assert.equal(socket.readyState, socket.CLOSING);
  socket.send('discarded');
  await tick();
  assert.equal(env.calls.some(call => call.command === 'native_ws_close'), false);
  env.pending.shift()(); await tick();
  assert.equal(env.calls.at(-1).command, 'native_ws_close');
  assert.equal(env.calls.at(-1).args.code, 1000);
  env.channels[0].callback({ type: 'close', code: 1000, reason: 'done', wasClean: true });
  env.channels[0].callback({ type: 'close', code: 1006, reason: '', wasClean: false });
  assert.deepEqual(closed, [{ code: 1000, reason: 'done', clean: true }]);
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(env.channels[0].cleaned, true);
});

test('connect failure emits error then abnormal close without exposing the rejection', async () => {
  const env = environment({ failConnect: true });
  const socket = new env.window.WebSocket(url);
  const events = [];
  socket.onerror = event => events.push(event.type);
  socket.onclose = event => events.push(event.code);
  await tick();
  assert.deepEqual(events, ['error', 1006]);
  assert.equal(env.channels[0].cleaned, true);
  assert.equal(env.warnings.flat().some(value => String(value).includes('synthetic')), false);
});

test('native error and close remain separate events', async () => {
  const env = environment();
  const socket = new env.window.WebSocket(url);
  const events = [];
  socket.onerror = event => events.push(event.type);
  socket.onclose = event => events.push(event.type);
  await tick();
  env.channels[0].callback({ type: 'error', message: 'WebSocket handshake rejected (HTTP 403)' });
  assert.equal(socket.readyState, socket.CONNECTING);
  env.channels[0].callback({ type: 'close', code: 1006, reason: '', wasClean: false });
  assert.deepEqual(events, ['error', 'close']);
  assert.ok(env.warnings.flat().includes('WebSocket handshake rejected (HTTP 403)'));
});

test('a rejected send also releases the registered native connection', async () => {
  const env = environment({ failSend: true });
  const socket = new env.window.WebSocket(url);
  const events = [];
  socket.onerror = event => events.push(event.type);
  socket.onclose = event => events.push(event.code);
  await tick(); env.open();
  socket.send('synthetic rejected send');
  await tick();
  assert.deepEqual(events, ['error', 1006]);
  assert.equal(env.calls.at(-1).command, 'native_ws_close');
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(env.channels[0].cleaned, true);
});

test('early creation waits for document bootstrap instead of a timer', async () => {
  const env = environment({ early: true });
  const socket = new env.window.WebSocket(url);
  await tick();
  assert.equal(env.calls.length, 0);
  assert.equal(socket.readyState, socket.CONNECTING);
  env.window.__TAURI__ = { core: env.core };
  env.document.readyState = 'interactive';
  env.document.dispatchEvent(new Event('DOMContentLoaded'));
  await tick();
  assert.equal(env.calls[0].command, 'native_ws_connect');
  env.open();
  assert.equal(socket.readyState, socket.OPEN);
});

test('pagehide requests cleanup of live native sockets', async () => {
  const env = environment();
  const first = new env.window.WebSocket(url);
  const second = new env.window.WebSocket(url);
  await tick(); env.open(0); env.open(1);
  env.window.dispatchEvent(new Event('pagehide'));
  await tick();
  assert.equal(env.calls.filter(call => call.command === 'native_ws_close').length, 2);
  assert.notEqual(env.calls[0].args.id, env.calls[1].args.id);
  assert.equal(first.readyState, first.CLOSING);
  assert.equal(second.readyState, second.CLOSING);
});

test('GLOBAL profile sends only its regional Socket.IO endpoint through the native bridge', async () => {
  const globalUrl = url.replace('api-mc-', 'api-wutheringwaves-');
  const env = environment({ profile: { region: 'GLOBAL', socketHost: 'api-wutheringwaves-wuwatappo.kurogames-global.com' } });
  assert.ok(new env.window.WebSocket(url) instanceof env.BrowserWebSocket);
  new env.window.WebSocket(globalUrl);
  await tick();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].args.url, globalUrl);
});
