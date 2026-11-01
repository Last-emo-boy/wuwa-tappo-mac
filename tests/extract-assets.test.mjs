import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { profile } from './frontend-context.mjs';
import { brotliCompressSync } from 'node:zlib';
import { extractAssets, findAssetEntries, findEmbeddedNsis, inspectStaticReferences, readPe, safeAssetPath, selectApplicationPayload } from '../scripts/extract-assets.mjs';

function fixture(assets) {
  const bytes = Buffer.alloc(8192);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeBigUInt64LE(0x140000000n, 0xb0);
  const section = 0x188;
  bytes.write('.rdata', section);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1e00, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  let dataOffset = 0x400;
  assets.forEach(([key, content], index) => {
    const entry = 0x200 + index * 32;
    const compressed = brotliCompressSync(Buffer.from(content));
    bytes.writeBigUInt64LE(BigInt(0x140001000 + dataOffset - 0x200), entry);
    bytes.writeBigUInt64LE(BigInt(Buffer.byteLength(key)), entry + 8);
    bytes.write(key, dataOffset);
    dataOffset += Buffer.byteLength(key);
    bytes.writeBigUInt64LE(BigInt(0x140001000 + dataOffset - 0x200), entry + 16);
    bytes.writeBigUInt64LE(BigInt(compressed.length), entry + 24);
    compressed.copy(bytes, dataOffset);
    dataOffset += compressed.length;
  });
  return bytes;
}

test('extracts arbitrary nested extensions using exact PHF bounds', () => {
  const bytes = fixture([['/index.html', '<html/>'], ['/nested/one.dat', 'payload'], ['/root.svg', '<svg/>']]);
  const entries = findAssetEntries(bytes);
  assert.deepEqual(entries.map(entry => entry.key), ['/index.html', '/nested/one.dat', '/root.svg']);
  assert.equal(entries[1].data.toString(), 'payload');
  assert.ok(entries[0].dataOffset + entries[0].compressedSize < entries[1].dataOffset);
});

test('rejects malformed and truncated PE input', () => {
  assert.throws(() => readPe(Buffer.from('not an executable')), /PE/);
  const bytes = fixture([['/index.html', '<html/>']]);
  assert.throws(() => readPe(bytes.subarray(0, 500)), /Truncated/);
  bytes.writeUInt32LE(0xfffffffe, 0x3c);
  assert.throws(() => readPe(bytes), /Invalid PE header/);
});

test('refuses traversal and non-file asset keys', () => {
  for (const key of ['relative', '/a/../secret', '/./a', '//absolute', '/a\\b', '/a%2fb', '/a?query', '/a\0b']) {
    assert.throws(() => safeAssetPath(key), /Unsafe asset path/);
  }
  assert.equal(safeAssetPath('/assets/icon.png'), 'assets/icon.png');
  assert.throws(() => findAssetEntries(fixture([['/index.html', '<html/>'], ['/../secret', 'content']])), /Unsafe asset path/);
});

test('does not accept a Brotli stream with bytes outside its declared boundary', () => {
  const bytes = fixture([['/index.html', '<html/>']]);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(0x218) + 1n, 0x218);
  assert.throws(() => findAssetEntries(bytes), /No Tauri frontend/);
});

test('static import resolution covers module imports, Vite maps, URL assets and CSS', () => {
  const entries = [
    { key: '/index.html', data: Buffer.from('<script src="./assets/main.js"></script><link href="./assets/a.css">') },
    { key: '/assets/main.js', data: Buffer.from('import { x } from "./other.js"; import("./lazy.js");new URL("icon.png",import.meta.url);const map=["assets/other.js"];') },
    { key: '/assets/other.js', data: Buffer.from('export const x=1;') },
    { key: '/assets/lazy.js', data: Buffer.from('export default 2;') },
    { key: '/assets/icon.png', data: Buffer.from('png') },
    { key: '/assets/a.css', data: Buffer.from('a{background:url("icon.png")}b{background:url(data:image/png;base64,x)}') },
  ];
  const result = inspectStaticReferences(entries);
  assert.deepEqual(result.missing, []);
  assert.equal(result.references.length, 7);
  const missing = inspectStaticReferences(entries.filter(entry => entry.key !== '/assets/lazy.js'));
  assert.equal(missing.missing[0].target, '/assets/lazy.js');
});

test('writes a complete extraction without changing its filenames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-extractor-test-'));
  try {
    const manifest = await extractAssets(fixture([['/index.html', '<html/>'], ['/assets/arbitrary.bin', 'bytes']]), directory);
    assert.equal(manifest.length, 2);
    assert.equal(await readFile(path.join(directory, 'assets/arbitrary.bin'), 'utf8'), 'bytes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('finds embedded NSIS by PE section end and bounded NSIS header', () => {
  const stub = fixture([['/index.html', '<html/>']]);
  const bytes = Buffer.concat([stub, Buffer.alloc(64)]);
  const header = stub.length;
  Buffer.from('\xef\xbe\xad\xdeNullsoftInst', 'latin1').copy(bytes, header + 4);
  bytes.writeUInt32LE(64, header + 24);
  assert.deepEqual(findEmbeddedNsis(bytes), { start: 0, header, end: bytes.length });
  bytes.writeUInt32LE(65, header + 24);
  assert.throws(() => findEmbeddedNsis(bytes), /No structurally valid/);
});

test('selects the legacy app name and the official variable-backed NSIS payload', () => {
  assert.equal(selectApplicationPayload('Path = $PLUGINSDIR/System.dll\n\nPath = WuwaTappo.exe\n\nPath = uninstall.exe\n'), 'WuwaTappo.exe');
  assert.equal(selectApplicationPayload('Path = $PLUGINSDIR/System.dll\r\n\r\nPath = $_21_\r\n\r\nPath = uninstall.exe\r\n'), '$_21_');
});

test('does not select unrelated executables, nested paths, or ambiguous payloads', () => {
  for (const listing of [
    'Path = uninstall.exe\nPath = other.exe\n',
    'Path = nested/WuwaTappo.exe\nPath = ../$_21_\n',
    'Path = WuwaTappo.exe\nPath = $_21_\n',
    'Path = $_21_\nPath = $_22_\n',
  ]) assert.throws(() => selectApplicationPayload(listing), /exactly one Wuwa Tappo/);
});

test('installer CLI extracts the selected NSIS variable and validates its Tauri assets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wuwa-installer-cli-test-'));
  try {
    const stub = fixture([['/index.html', '<html/>']]);
    const installer = Buffer.concat([stub, Buffer.alloc(64)]);
    Buffer.from('\xef\xbe\xad\xdeNullsoftInst', 'latin1').copy(installer, stub.length + 4);
    installer.writeUInt32LE(64, stub.length + 24);
    const installerPath = path.join(directory, 'installer.exe');
    const sevenzip = path.join(directory, '7zz');
    const applicationPath = path.join(directory, 'application.exe');
    const output = path.join(directory, 'frontend');
    await writeFile(installerPath, installer);
    await writeFile(applicationPath, stub);
    await writeFile(sevenzip, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'l') console.log('Path = $_21_\\n\\nPath = uninstall.exe');
else {
  if (args.at(-1) !== '$_21_') process.exit(2);
  const output = args.find(arg => arg.startsWith('-o')).slice(2);
  fs.copyFileSync(path.join(__dirname, 'application.exe'), path.join(output, '$_21_'));
}
`, { mode: 0o755 });
    const run = () => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/extract-assets.mjs'), '--installer', installerPath, '--sevenzip', sevenzip, '--output', output], { encoding: 'utf8' });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, 1);
    assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), '<html/>');
    await writeFile(applicationPath, 'not an application');
    const malformed = run();
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /Expected a PE executable/);
    await writeFile(applicationPath, fixture([['/other.html', '<html/>']]));
    const missingFrontend = run();
    assert.notEqual(missingFrontend.status, 0);
    assert.match(missingFrontend.stderr, /No Tauri frontend/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all static references in the recovered production frontend exist', async () => {
  const root = path.resolve(import.meta.dirname, '..', profile.frontendDir);
  const entries = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) await visit(filename);
      else entries.push({ key: `/${path.relative(root, filename).split(path.sep).join('/')}`, data: await readFile(filename) });
    }
  }
  await visit(root);
  assert.ok(entries.some(entry => entry.key === '/app-icon.png'));
  assert.ok(entries.some(entry => entry.key === '/kurodata-browser/kurodata.esm.min.js'));
  const result = inspectStaticReferences(entries);
  assert.deepEqual(result.missing, []);
  assert.ok(result.references.length > 100);
});
