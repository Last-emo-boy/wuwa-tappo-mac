import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getRegionProfile } from '../scripts/regions.mjs';

export const profile = getRegionProfile();
export const root = path.resolve(import.meta.dirname, '..');
export const assetDirectory = path.join(root, profile.frontendDir, 'assets');
export const contract = JSON.parse(readFileSync(path.join(root, 'tests', profile.id === 'cn' ? 'contracts.json' : 'contracts-global.json'), 'utf8'));
export const sourceFiles = () => readdirSync(assetDirectory).filter(name => name.endsWith('.js'));
export function findSource(predicate) {
  const matches = sourceFiles().map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ name, source }) => predicate(source, name));
  if (matches.length !== 1) throw new Error(`Expected one ${profile.region} source, found ${matches.length}`);
  return matches[0];
}
