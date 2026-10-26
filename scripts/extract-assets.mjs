import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const decoder = new TextDecoder('utf-8', { fatal: true });

export function readPe(bytes, base = 0) {
  if (base < 0 || base + 64 > bytes.length || bytes.toString('ascii', base, base + 2) !== 'MZ') {
    throw new Error('Expected a PE executable.');
  }
  const header = base + bytes.readUInt32LE(base + 0x3c);
  if (header + 24 > bytes.length || bytes.toString('ascii', header, header + 4) !== 'PE\0\0') {
    throw new Error('Invalid PE header.');
  }
  const count = bytes.readUInt16LE(header + 6);
  const optionalSize = bytes.readUInt16LE(header + 20);
  const optional = header + 24;
  if (!count || count > 96 || optionalSize < 32 || optional + optionalSize + count * 40 > bytes.length) {
    throw new Error('Truncated PE section table.');
  }
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unsupported PE optional header.');
  const imageBase = magic === 0x20b
    ? Number(bytes.readBigUInt64LE(optional + 24))
    : bytes.readUInt32LE(optional + 28);
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const entry = optional + optionalSize + index * 40;
    const name = bytes.toString('ascii', entry, entry + 8).replace(/\0.*$/, '');
    const address = bytes.readUInt32LE(entry + 12);
    const size = bytes.readUInt32LE(entry + 16);
    const offset = base + bytes.readUInt32LE(entry + 20);
    if (size && (offset < base || offset + size > bytes.length)) throw new Error('Truncated PE section.');
    sections.push({ name, address, size, offset });
  }
  return { imageBase, sections, pointerSize: magic === 0x20b ? 8 : 4,
    rawEnd: Math.max(...sections.map(section => section.offset + section.size)) };
}

function fileOffset(pe, address, length) {
  const relative = address - pe.imageBase;
  const section = pe.sections.find(item => relative >= item.address && relative + length <= item.address + item.size);
  return section ? section.offset + relative - section.address : null;
}

export function safeAssetPath(key) {
  if (!key.startsWith('/') || key.includes('\\') || /[\0-\x1f\x7f?#%]/.test(key)) {
    throw new Error(`Unsafe asset path: ${JSON.stringify(key)}`);
  }
  const parts = key.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe asset path: ${JSON.stringify(key)}`);
  }
  return parts.join('/');
}

// Tauri stores PHF entries as (&str, &[u8]): two pointer/length pairs.
// Read those bounds instead of guessing Brotli boundaries or file extensions.
export function findAssetEntries(bytes) {
  const pe = readPe(bytes);
  if (pe.pointerSize !== 8) throw new Error('The Wuwa Tappo application must be a 64-bit PE.');
  const section = pe.sections.find(item => item.name === '.rdata');
  if (!section) throw new Error('PE has no .rdata section.');
  const entries = [];
  for (let offset = section.offset; offset + 32 <= section.offset + section.size; offset += 8) {
    const keyLength = bytes.readUInt32LE(offset + 8);
    if (!keyLength || keyLength > 2048 || bytes.readUInt32LE(offset + 12) !== 0) continue;
    const keyOffset = fileOffset(pe, Number(bytes.readBigUInt64LE(offset)), keyLength);
    if (keyOffset === null || bytes[keyOffset] !== 47) continue;
    let key;
    try { key = decoder.decode(bytes.subarray(keyOffset, keyOffset + keyLength)); }
    catch { continue; }
    const length = bytes.readUInt32LE(offset + 24);
    if (!length || bytes.readUInt32LE(offset + 28) !== 0) continue;
    const dataOffset = fileOffset(pe, Number(bytes.readBigUInt64LE(offset + 16)), length);
    if (dataOffset === null) continue;
    let result;
    try {
      result = brotliDecompressSync(bytes.subarray(dataOffset, dataOffset + length), {
        info: true, maxOutputLength: 128 * 1024 * 1024,
      });
    } catch { continue; }
    if (result.engine.bytesWritten !== length) continue;
    const relativePath = safeAssetPath(key);
    entries.push({ key, relativePath, tableOffset: offset, dataOffset, compressedSize: length, data: result.buffer });
  }
  if (!entries.some(entry => entry.key === '/index.html')) throw new Error('No Tauri frontend found in this application.');
  const unique = new Map();
  for (const entry of entries) {
    const previous = unique.get(entry.key);
    if (previous && !previous.data.equals(entry.data)) throw new Error(`Conflicting embedded asset: ${entry.key}`);
    unique.set(entry.key, entry);
  }
  return [...unique.values()];
}

export function findEmbeddedNsis(bytes) {
  readPe(bytes);
  const signature = Buffer.from('\xef\xbe\xad\xdeNullsoftInst', 'latin1');
  const headers = [];
  for (let offset = bytes.indexOf(signature); offset >= 0; offset = bytes.indexOf(signature, offset + 1)) {
    const header = offset - 4;
    if (header < 0 || header + 28 > bytes.length) continue;
    const following = bytes.readUInt32LE(header + 24);
    if (following >= 28 && header + following <= bytes.length) headers.push({ header, end: header + following });
  }
  for (let start = bytes.indexOf('MZ'); start >= 0; start = bytes.indexOf('MZ', start + 2)) {
    let pe;
    try { pe = readPe(bytes, start); } catch { continue; }
    const nsis = headers.find(item => pe.rawEnd === item.header);
    if (nsis) return { start, end: nsis.end, header: nsis.header };
  }
  throw new Error('No structurally valid embedded NSIS installer found.');
}

export async function extractAssets(bytes, output) {
  const entries = findAssetEntries(bytes);
  for (const entry of entries) {
    const destination = path.join(output, entry.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
  }
  return entries.map(({ data, ...entry }) => ({ ...entry, size: data.length }));
}

function staticReferences(source, extension) {
  const values = [];
  if (extension === '.html') {
    for (const match of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) values.push(match[1]);
  }
  if (extension === '.css' || extension === '.html') {
    for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) values.push(match[1]);
  }
  if (extension === '.js') {
    for (const match of source.matchAll(/\b(?:import|export)\s*(?:[^;]*?\bfrom\s*)?["']([^"']+)["']/g)) values.push(match[1]);
    for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) values.push(match[1]);
    for (const match of source.matchAll(/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) values.push(match[1]);
    for (const match of source.matchAll(/["'](\/?(?:assets|kurodata-browser)\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|svg|woff2?))["']/g)) {
      values.push(`/${match[1].replace(/^\//, '')}`);
    }
  }
  return [...new Set(values)].filter(value => !/^(?:[a-z]+:|\/\/|#)/i.test(value));
}

export function inspectStaticReferences(entries) {
  const keys = new Set(entries.map(entry => entry.key));
  const references = [];
  for (const entry of entries) {
    const extension = path.posix.extname(entry.key);
    if (!['.js', '.css', '.html'].includes(extension)) continue;
    for (const reference of staticReferences(entry.data.toString('utf8'), extension)) {
      const target = path.posix.resolve(path.posix.dirname(entry.key), reference.split(/[?#]/)[0]);
      references.push({ source: entry.key, reference, target, exists: keys.has(target) });
    }
  }
  return { references, missing: references.filter(reference => !reference.exists) };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!['--payload', '--installer', '--sevenzip', '--output'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Usage: node scripts/extract-assets.mjs (--payload app.exe | --installer setup.exe --sevenzip /path/to/7zz) --output frontend');
    }
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!options.output || Boolean(options.payload) === Boolean(options.installer)) throw new Error('Choose --payload or --installer and provide --output.');
  let bytes;
  if (options.payload) bytes = await readFile(options.payload);
  else {
    if (!options.sevenzip) throw new Error('--installer requires --sevenzip; the installer is never executed.');
    const installer = await readFile(options.installer);
    const bounds = findEmbeddedNsis(installer);
    const temporary = await mkdtemp(path.join(tmpdir(), 'wuwatappo-extract-'));
    try {
      const filename = path.join(temporary, 'setup.exe');
      await writeFile(filename, installer.subarray(bounds.start, bounds.end));
      const result = spawnSync(options.sevenzip, ['e', '-y', '-bd', `-o${temporary}`, filename, 'WuwaTappo.exe'], {
        encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`7-Zip extraction failed: ${result.stderr || result.stdout}`);
      bytes = await readFile(path.join(temporary, 'WuwaTappo.exe'));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const entries = findAssetEntries(bytes);
  const references = inspectStaticReferences(entries);
  if (references.missing.length) throw new Error(`Unresolved embedded imports: ${JSON.stringify(references.missing)}`);
  const manifest = await extractAssets(bytes, path.resolve(options.output));
  console.log(JSON.stringify({ output: path.resolve(options.output), count: manifest.length,
    staticReferences: references.references.length, assets: manifest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
