#!/bin/bash
set -Eeuo pipefail

PHASE='启动'
failed() {
  local status=$?
  printf '打包失败：%s（第 %s 行，退出状态 %s）。\n' "$PHASE" "$1" "$status" >&2
  exit "$status"
}
trap 'failed "$LINENO"' ERR
phase() {
  PHASE="$1"
  printf '打包阶段：%s\n' "$PHASE"
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/Wuwa Tappo CN Mac.app"
OUTPUT="$ROOT/dist"

usage() {
  printf '%s\n' '用法：bash scripts/package-macos.sh [--app 完整应用路径] [--output 输出目录]'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|--output)
      if [ "$#" -lt 2 ]; then usage >&2; exit 2; fi
      if [ "$1" = --app ]; then APP="$2"; else OUTPUT="$2"; fi
      shift 2
      ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' '完整 macOS 安装包需要在 Mac 上生成。' >&2
  exit 1
fi
if [ ! -d "$APP/Contents" ] || [ ! -f "$APP/Contents/Info.plist" ]; then
  printf '%s\n' '未找到完整应用，请先运行 npm run build。' >&2
  exit 1
fi

phase '读取应用信息'
PLIST="$APP/Contents/Info.plist"
IDENTIFIER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
MINIMUM=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST")
EXPECTED_VERSION=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$ROOT/src-tauri/tauri.conf.json")
if [ "$IDENTIFIER" != dev.w33d.wuwatappo.cn.mac ] || [ "$VERSION" != "$EXPECTED_VERSION" ] || [ "$MINIMUM" != 13.0 ]; then
  printf '%s\n' '应用标识、版本或最低系统要求与国服构建配置不一致。' >&2
  exit 1
fi
case "$EXECUTABLE" in
  ''|*/*|.|..) printf '%s\n' '应用主程序名称无效。' >&2; exit 1 ;;
esac
BINARY="$APP/Contents/MacOS/$EXECUTABLE"
phase '检查架构与签名'
if [ ! -f "$BINARY" ] || [ "$(/usr/bin/lipo -archs "$BINARY")" != arm64 ]; then
  printf '%s\n' '安装包必须包含 Apple Silicon 原生主程序。' >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$APP"

# Tauri 将前端编译进主程序；检查打包输入及嵌入路径，而不是复制用户数据。
phase '检查国服内置资源'
node --input-type=module -e '
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const [root, binary] = process.argv.slice(1);
const source = path.join(root, "build/frontend");
const index = await readFile(path.join(source, "index.html"), "utf8");
const entry = index.match(/src="\.\/([^\"]+\.js)"/)?.[1];
if (!entry) throw new Error("缺少已准备的国服前端入口。");
const main = await readFile(path.join(source, entry), "utf8");
if (!main.includes("const APP_REGION=\"CN\"")) throw new Error("安装包必须使用国服前端。");
const bytes = await readFile(binary);
for (const asset of ["/index.html", `/${entry}`, "/app-icon.png"]) {
  if (!bytes.includes(Buffer.from(asset))) throw new Error(`应用未嵌入必要资源：${asset}`);
}
const contents = await readdir(path.dirname(path.dirname(binary)));
for (const name of ["Library", "Logs", "Caches", "Application Support"]) {
  if (contents.includes(name)) throw new Error(`应用中不应包含用户数据目录：${name}`);
}
' "$ROOT" "$BINARY"

phase '创建临时打包目录'
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/wuwatappo-package.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
NAME="WuwaTappo-CN-Mac-$VERSION-arm64"
phase '复制应用并复查签名'
ditto --norsrc --noextattr --noqtn --noacl "$APP" "$STAGE/Wuwa Tappo CN Mac.app"
/usr/bin/codesign --verify --deep --strict "$STAGE/Wuwa Tappo CN Mac.app"
phase '生成 ZIP'
ditto -c -k --norsrc --noextattr --noqtn --noacl --keepParent "$STAGE/Wuwa Tappo CN Mac.app" "$STAGE/$NAME.zip"
phase '生成 DMG'
mkdir "$STAGE/dmg"
mv "$STAGE/Wuwa Tappo CN Mac.app" "$STAGE/dmg/"
ln -s /Applications "$STAGE/dmg/Applications"
hdiutil create -volname 'Wuwa Tappo CN Mac' -srcfolder "$STAGE/dmg" -format UDZO "$STAGE/$NAME.dmg"
phase '校验 DMG'
hdiutil verify "$STAGE/$NAME.dmg"
phase '交付安装包'
mv "$STAGE/$NAME.zip" "$STAGE/$NAME.dmg" "$OUTPUT/"
printf '完整国服安装包：\n%s\n%s\n' "$OUTPUT/$NAME.zip" "$OUTPUT/$NAME.dmg"
