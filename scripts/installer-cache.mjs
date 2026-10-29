import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegionProfile } from './regions.mjs';
import { pinnedInstallerCache } from './sync-upstream.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = getRegionProfile();
const lock = JSON.parse(await readFile(path.join(root, profile.upstreamLock), 'utf8'));
const cache = pinnedInstallerCache(lock, root, profile);
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required for installer cache metadata');
await appendFile(process.env.GITHUB_OUTPUT, `key=${cache.key}\npath=${cache.path}\n`);
console.log(JSON.stringify(cache));
