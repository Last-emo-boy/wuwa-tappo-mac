import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRegionProfile } from './regions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function tauriArguments(action, profile, extra = []) {
  if (action === 'icons') return ['icon', `${profile.frontendDir}/app-icon.png`, '--output', profile.iconsDir, ...extra];
  if (!['dev', 'build'].includes(action)) throw new Error(`未知构建操作：${action}`);
  return [action, ...(action === 'build' ? ['--bundles', 'app'] : []),
    ...(profile.tauriConfig ? ['--config', profile.tauriConfig] : []), ...extra];
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main([action, ...extra]) {
  const profile = getRegionProfile();
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  if (action === 'test:rust') {
    const environment = { ...process.env };
    if (profile.tauriConfig) environment.TAURI_CONFIG = await readFile(path.join(root, profile.tauriConfig), 'utf8');
    run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', ...extra], environment);
    return;
  }
  if (action === 'dev' || action === 'build') {
    run(process.execPath, [cli, ...tauriArguments('icons', profile)]);
    run(process.execPath, [path.join(root, 'scripts/prepare-frontend.mjs')]);
  }
  run(process.execPath, [cli, ...tauriArguments(action, profile, extra)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
