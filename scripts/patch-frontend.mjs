import { parse } from 'acorn';

const macReleasesUrl = 'https://github.com/Last-emo-boy/wuwa-tappo-mac/releases';

function visitNodes(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visitNodes(child, callback));
    else if (value && typeof value === 'object') visitNodes(value, callback);
  }
}

export function patchSessionBarriers(source, expectedWrappers = 2) {
  let changes = 0;
  const patched = source.replace(
    /async function (invoke(?:\$\d+)?)\(e,t=\{\},n\)\{return window\.__TAURI_INTERNALS__\.invoke\(e,t,n\)\}/g,
    (_, name) => {
      changes += 1;
      return `async function ${name}(e,t={},n){if(e==="open_login_window"||e==="open_panel_window"||e==="reset_local_data"||e==="plugin:event|emit"&&(t.event==="cat-auth-login-success"||t.event==="cat-auth-logout"))await window.__WUWATAPPO_SESSION__?.flush();return window.__TAURI_INTERNALS__.invoke(e,t,n)}`;
    },
  );
  if (changes !== expectedWrappers) throw new Error(`Expected ${expectedWrappers} original Tauri invoke wrappers, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function patchLoginReady(source) {
  const original='function N(n){return o(u,t=>{n(t.payload??{})})}';
  const replacement='async function N(n){const unlisten=await o(u,t=>{n(t.payload??{})});await window.__TAURI_INTERNALS__.invoke("login_window_ready");return unlisten}';
  if(source.split(original).length!==2) throw new Error('Original login listener bridge changed; reconcile modal readiness before building.');
  return source.replace(original,replacement);
}

export function patchDomesticSdkUrls(source) {
  if (!source.includes('const APP_REGION="CN"')) {
    throw new Error('Expected the official CN frontend. Extract the CN installer before building.');
  }
  let changes = 0;
  const patched = source.replace(
    /(isdk(?:Src|Css)=")(\/\/pro-cdn-sdk\.kurogame\.com\/pro\/web-sdk\/1\.x\/(?:kr-sdk\.js|style\.css)")/g,
    (_, prefix, url) => {
      changes += 1;
      return `${prefix}https:${url}`;
    },
  );
  if (changes !== 2) throw new Error(`Expected 2 CN SDK URLs, found ${changes}. Reconcile the app version before building.`);
  return patched;
}

export function domesticLoginLoader(source) {
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const loaders = tree.body.filter(node => node.type === 'FunctionDeclaration' &&
    /\.dataset\.kuroSdkRetry="true"/.test(source.slice(node.start, node.end)));
  const loader = loaders[0];
  const force = loader?.params[0];
  if (loaders.length !== 1 || !loader.async || loader.params.length !== 1 ||
      force?.type !== 'AssignmentPattern' || force.left.type !== 'Identifier' ||
      source.slice(force.right.start, force.right.end) !== '!1') {
    throw new Error('Original CN SDK reload function changed; reconcile the login reload patch before building.');
  }
  return loader;
}

export function patchDomesticLoginReload(source) {
  const loader = domesticLoginLoader(source);
  const body = source.slice(loader.start, loader.end);
  const insertions = [...body.matchAll(/([$\w]+)\.dataset\.kuroSdkRetry="true"|,document\.head\.appendChild\(([$\w]+)\),[$\w]+=window\.setTimeout\(/g)];
  if (insertions.length !== 2 || !insertions[0][1] || insertions[0][1] !== insertions[1][2]) {
    throw new Error('Original CN SDK script insertion changed; reconcile the login reload patch before building.');
  }
  const script = insertions[1][2], offset = loader.start + insertions[1].index;
  const cleanup = `,${loader.params[0].left.name}&&([...document.scripts].filter(__macScript=>__macScript.src===${script}.src).forEach(__macScript=>__macScript.remove()),document.getElementById("KrSDK")?.remove())`;
  return source.slice(0, offset) + cleanup + source.slice(offset);
}

export function patchMacReleasesButton(source) {
  const nodes = [];
  visitNodes(parse(source, { sourceType: 'module', ecmaVersion: 'latest' }), node => nodes.push(node));
  const property = (node, name) => node?.type === 'ObjectExpression'
    ? node.properties.find(prop => prop.key?.name === name)?.value : undefined;
  const buttons = nodes.filter(node => node.type === 'CallExpression' && node.arguments[0]?.value === 'button'
    && property(node.arguments[1], 'class')?.value === 'setting-btn btn-check-update');
  const changed = () => new Error('Original update button changed; reconcile the Mac Releases action before building.');
  if (buttons.length !== 1) throw changed();
  const [, props, label] = buttons[0].arguments;
  const disabled = property(props, 'disabled'), click = property(props, 'onClick');
  const busy = disabled?.right;
  const handler = click?.arguments?.[0];
  if (disabled?.operator !== '||' || disabled.left.operator !== '!' || busy?.type !== 'MemberExpression'
    || busy.object.type !== 'Identifier' || busy.property.name !== 'value' || handler?.type !== 'Identifier'
    || !label || !source.slice(label.start, label.end).includes('"setting_version_check_btn"')) throw changed();
  const handlers = nodes.filter(node => node.type === 'FunctionDeclaration' && node.id.name === handler.name
    && source.slice(node.start, node.end).includes('"setting_version_checking"'));
  if (handlers.length !== 1 || !handlers[0].async) throw changed();
  const body = handlers[0].body;
  const status = source.slice(body.start, body.end).match(/([$\w]+)\.value=[$\w]+\("setting_version_checking"\)/)?.[1];
  if (!status) throw changed();
  const flag = `${busy.object.name}.value`, url = JSON.stringify(macReleasesUrl);
  const open = `{if(${flag})return;${flag}=!0;${status}.value="";try{await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url",{url:${url}})}catch(error){console.warn("[macOS] Could not open GitHub Releases",error);${status}.value=${url}}finally{${flag}=!1}}`;
  const edits = [[disabled, flag], [label, '"GitHub Releases"'], [body, open]];
  for (const [node, replacement] of edits.sort(([a], [b]) => b.start - a.start)) {
    source = source.slice(0, node.start) + replacement + source.slice(node.end);
  }
  return source;
}

export function patchMacShortcutLabels(source) {
  const original = 'function formatModifiers(e){return[[2,"Ctrl"],[1,"Alt"],[4,"Shift"],[8,"Win"]].filter(([t])=>e&Number(t)).map(([,t])=>String(t))}';
  if (source.split(original).length !== 2) throw new Error('Original shortcut modifier labels changed; reconcile macOS shortcut display before building.');
  return source.replace(original, original.replace('[1,"Alt"]', '[1,"Option"]').replace('[8,"Win"]', '[8,"Cmd"]'));
}

export function patchMacUpdater(source) {
  const guard = /function isAppUpdaterEnabled\(\)\{if\(!isTauriRuntime\(\)\)return!1;const ([$\w]+)="true"\.toLowerCase\(\);return \1!=="false"&&\1!=="0"\}/g;
  if ([...source.matchAll(guard)].length !== 1) throw new Error('Original updater guard changed; reconcile the Mac update path before building.');
  return source.replace(guard, 'function isAppUpdaterEnabled(){return!1}');
}

export function patchActivityConfigConcurrency(source) {
  const endpoint = /function activityInfo\(\)\{const ([$\w]+)=\{loading:!1,reload:!0\};return jsonpClient\.get\("api\/common\/activity-config",\{\},\1\)\}/g;
  if ([...source.matchAll(endpoint)].length !== 1) throw new Error('Original activity-config request changed; reconcile Mac startup before building.');
  return source.replace(endpoint, 'let __wuwatappoActivityConfigPending;function activityInfo(){return __wuwatappoActivityConfigPending??=jsonpClient.get("api/common/activity-config",{},{loading:!1,reload:!0}).finally(()=>{__wuwatappoActivityConfigPending=void 0})}');
}

export function patchMacAbout(source, region = 'CN') {
  const headings = [...source.matchAll(/<h2 (data-v-[a-f0-9]+)>系统配置<\/h2>/g)];
  if (headings.length !== 1) throw new Error('Original About system section changed; reconcile the Mac build information before building.');
  const original = headings[0][0], scope = headings[0][1];
  const remotes = [...source.matchAll(/t=([$\w]+)\(\(\)=>k\("about_content"\)\?String\(v\("about_content"\)\)\.trim\(\):""\)/g)];
  if (remotes.length !== 1) throw new Error('Original remote About content changed; reconcile the Mac build information before building.');
  const [remote, computed] = remotes[0];
  const info = region === 'GLOBAL'
    ? `<h2 ${scope}>macOS community build</h2><p ${scope}>Wuwa Tappo Global Mac · Unofficial · Apple Silicon · macOS 13+</p>`
    : `<h2 ${scope}>macOS 重建版</h2><p ${scope}>Wuwa Tappo CN Mac · 非官方重建 · Apple Silicon · macOS 13 及以上</p>`;
  const banner = `<section class="about-section" ${scope}>${info}</section>`;
  return source
    .replace(original, `${info}<h3 ${scope}>Windows 原版系统配置</h3>`)
    .replace(remote, `t=${computed}(()=>{const html=k("about_content")?String(v("about_content")).trim():"";return html?${JSON.stringify(banner)}+html.replace("系统配置","Windows 原版系统配置").replace("系統配備","Windows 原版系統配備"):""})`);
}

export function patchGlobalAuthListener(source) {
  const bridge = 'async function onOpenUrl(e){return await listen("deep-link://new-url",t=>{e(t.payload)})}';
  const wake = 'async function onOpenUrl(e){return await listen("mac-oauth-callback-ready",()=>{getCurrent().then(t=>{if(t?.length)return e(t)}).catch(()=>console.warn("[macOS] OAuth callback could not be read"))})}';
  const current = 'try{const t=await getCurrent();t?.length&&handleRawUrls(t)}catch(t){console.warn("[overseas-auth] getCurrent failed:",t)}';
  const listener = 'try{unlisten=await onOpenUrl(t=>{handleRawUrls(t)})}catch(t){throw console.warn("[overseas-auth] onOpenUrl failed:",t),bound=!1,t}';
  if (source.split(bridge).length !== 2 || source.split(current + listener).length !== 2) throw new Error('Original GLOBAL OAuth callback binding changed; reconcile cold and warm callback delivery before building.');
  return source.replace(bridge, wake).replace(current + listener, listener + current);
}

export function patchMacLayoutBarriers(source) {
  const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const targets = [];
  visitNodes(tree, node => {
    if (node.type !== 'FunctionDeclaration') return;
    const content = source.slice(node.start, node.end);
    if (content.includes('[taskbar-insets] desktop state refresh failed')
      || (content.includes('[main-window-bounds] sync failed') && content.includes('syncMainWindowContentBoundsNow'))) targets.push(node);
  });
  if (targets.length !== 2) throw new Error('Original desktop layout barriers changed; reconcile macOS layout before building.');
  const frames = [];
  for (const target of targets) {
    const matches = [];
    visitNodes(target.body, node => {
      if (node.type === 'AwaitExpression' && node.argument.type === 'NewExpression'
        && node.argument.callee.type === 'Identifier' && node.argument.callee.name === 'Promise'
        && source.slice(node.argument.start, node.argument.end).includes('requestAnimationFrame')) matches.push(node);
    });
    if (matches.length !== 1) throw new Error('Original desktop layout frame changed; reconcile macOS layout before building.');
    frames.push(matches[0]);
  }
  for (const frame of frames.sort((a, b) => b.start - a.start)) source = source.slice(0, frame.start) + 'await __wuwatappoMacLayoutBarrier()' + source.slice(frame.end);
  const helper = `async function __wuwatappoMacLayoutBarrier(){
  const nativeWindow=window.__TAURI__.window.getCurrentWindow();
  const [size,scale]=await Promise.all([nativeWindow.innerSize(),nativeWindow.scaleFactor()]);
  const root=document.documentElement;
  if(!root)throw new Error("macOS DOM layout root is unavailable");
  getComputedStyle(root).getPropertyValue("--pet-scale");
  const rootRect=root.getBoundingClientRect();
  const dockRect=document.querySelector(".pet-dock")?.getBoundingClientRect();
  const width=window.innerWidth,height=window.innerHeight;
  if(!Number.isFinite(scale)||scale<=0||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Number.isFinite(size.width)||!Number.isFinite(size.height)||Math.abs(width-size.width/scale)>2||Math.abs(height-size.height/scale)>2)throw new Error("macOS layout viewport does not match native window");
  for(const rect of[rootRect,dockRect])if(rect&&![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite))throw new Error("macOS DOM layout geometry is invalid");
}`;
  return helper + source;
}
