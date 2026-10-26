import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { patchSessionBarriers, patchLoginReady, patchDomesticSdkUrls, patchMacUpdateFeedback, patchMacUpdater, patchMacAbout, patchDomesticLoginReload } from './patch-frontend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'frontend');
const output = path.join(root, 'build/frontend');
const index = await readFile(path.join(source, 'index.html'), 'utf8');
const entry = index.match(/src="\.\/([^\"]+\.js)"/)?.[1];
if (!entry) throw new Error('Original frontend entry module not found.');
const entrySource = patchSessionBarriers(patchMacUpdater(patchDomesticSdkUrls(await readFile(path.join(source, entry), 'utf8'))));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await writeFile(path.join(output, 'index.html'), index.replace('<html lang="en">', '<html lang="zh-CN">'));
await cp(path.join(root,'scripts/bootstrap.html'),path.join(output,'bootstrap.html'));
const entryPath = path.join(output, entry);
await writeFile(entryPath, entrySource);
const bridges=(await readdir(path.join(output,'assets'))).filter(name=>/^modalBridge-.*\.js$/.test(name));
if(bridges.length!==1) throw new Error('Expected one original modal event bridge.');
const bridge=path.join(output,'assets',bridges[0]);
await writeFile(bridge,patchLoginReady(await readFile(bridge,'utf8')));
for (const [name, patch] of [['index-uvq2LdUl.js', patchMacUpdateFeedback], ['index-CfpAUGuq.js', patchMacAbout], ['useLogin-xp7tYXSp.js', patchDomesticLoginReload]]) {
  const file = path.join(output, 'assets', name);
  await writeFile(file, patch(await readFile(file, 'utf8')));
}
console.log(`Prepared official CN frontend at ${output}`);
