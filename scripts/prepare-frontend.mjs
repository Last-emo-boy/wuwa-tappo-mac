import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getRegionProfile } from './regions.mjs';
import { patchSessionBarriers, patchLoginReady, patchDomesticSdkUrls, patchMacUpdateFeedback, patchMacUpdater, patchMacAbout, patchDomesticLoginReload, patchGlobalAuthListener, patchMacLayoutBarriers } from './patch-frontend.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = getRegionProfile();
const source = path.join(root, profile.frontendDir);
const output = path.join(root, profile.preparedDir);
const index = await readFile(path.join(source, 'index.html'), 'utf8');
const entry = index.match(/src="\.\/([^\"]+\.js)"/)?.[1];
if (!entry) throw new Error('Original frontend entry module not found.');
const files = new Map(await Promise.all((await readdir(path.join(source, 'assets')))
  .filter(name => name.endsWith('.js'))
  .map(async name => [`assets/${name}`, await readFile(path.join(source, 'assets', name), 'utf8')])));
const original = files.get(entry);
if (!original?.includes(`const APP_REGION="${profile.region}"`)) throw new Error(`Expected official ${profile.region} frontend.`);
let main = patchMacUpdater(original);
main = profile.region === 'CN' ? patchDomesticSdkUrls(main) : patchGlobalAuthListener(main);
files.set(entry, patchSessionBarriers(main));

function patchOne(description, matches, patch) {
  const selected = [...files].filter(([name, content]) => matches(name, content));
  if (selected.length !== 1) throw new Error(`Expected one original ${description}, found ${selected.length}. Reconcile the upstream version before building.`);
  const [name, content] = selected[0];
  files.set(name, patch(content));
}

patchOne('modal event bridge', name => /\/modalBridge-[^/]+\.js$/.test(name), patchLoginReady);
patchOne('update feedback view', (_, content) => /\.value=n\("setting_version_check_failed"\)/.test(content), patchMacUpdateFeedback);
patchOne('About view', (_, content) => /t=[$\w]+\(\(\)=>k\("about_content"\)/.test(content), content => patchMacAbout(content, profile.region));
patchOne('main layout view', (_, content) => content.includes('[main] window layout during open failed'), patchMacLayoutBarriers);
if (profile.region === 'CN') patchOne('domestic SDK loader', (name, content) => name !== entry && content.includes('t.dataset.kuroSdkRetry="true"'), patchDomesticLoginReload);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await writeFile(path.join(output, 'index.html'), profile.region === 'CN' ? index.replace('<html lang="en">', '<html lang="zh-CN">') : index);
const bootstrap = await readFile(path.join(root, 'scripts/bootstrap.html'), 'utf8');
await writeFile(path.join(output, 'bootstrap.html'), bootstrap
  .replace('<title>Wuwa Tappo CN Mac</title>', `<title>${profile.productName}</title>`)
  .replace('<h1>Wuwa Tappo · 国服</h1>', `<h1>Wuwa Tappo · ${profile.label}</h1>`));
for (const [name, content] of files) await writeFile(path.join(output, name), content);
console.log(`Prepared official ${profile.region} frontend at ${output}`);
