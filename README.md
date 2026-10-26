# Wuwa Tappo 国服 · macOS

[![构建](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml/badge.svg)](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml)
[![下载](https://img.shields.io/github/v/release/Last-emo-boy/wuwa-tappo-mac?label=下载)](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)

**把 Wuwa Tappo 国服带到 Mac。** 保留国服界面、角色资源和官方服务，使用 Rust + Tauri 重建 macOS 原生后端，不需要 Wine、Windows 或虚拟机。

这是社区维护的**非官方国服适配版**，不支持国际服。当前对齐国服 **1.0.0**；官方后续版本通过自动检查和兼容性验证跟进。

## 下载与使用

前往 **[最新版本](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)** 下载 `.dmg`，将 **Wuwa Tappo CN Mac.app** 拖入「应用程序」后打开。也可下载 `.zip` 解压安装。

- **系统：** Apple Silicon（M 系列），macOS 13 或更高版本。暂未提供 Intel 版本。
- **完整资源：** 安装包包含国服界面与内嵌资源，不需要用户另行下载或提取 EXE。登录、资源更新及在线功能仍需要联网。
- **首次打开：** 当前版本未经过 Apple 公证；如 macOS 阻止打开，请在「系统设置 → 隐私与安全性」中确认来源后选择「仍要打开」。无需关闭系统安全保护。
- **输入监控：** 在「系统设置 → 隐私与安全性 → 输入监控」中添加并开启 `/Applications/Wuwa Tappo CN Mac.app`。按系统提示退出并重新打开，桌宠才能响应全局键盘和鼠标输入。
- **登录：** 使用自己的国服账号，在官方登录界面操作。首次启动可选择「仅本次会话」或通过钥匙串记住登录。

更新时先退出旧版，再覆盖「应用程序」中的同名应用；不要同时运行多个副本。若更新后桌宠不响应输入，请检查输入监控权限，必要时移除旧条目、重新添加最新版并重启应用。

## 功能与当前状态

- 透明桌宠窗口、显示器定位、缩放、置顶与鼠标穿透。
- 原生键盘/鼠标监听、输入权限状态提示与授权后的监听恢复。
- 点击计数本地保存，按账号和国服环境隔离，并沿用官方同步协议。
- 国服官方登录、原有面板、角色与物品界面。
- 原生 WebSocket 联机连接、房间创建与退出。
- 菜单栏控制、开机启动、日志脱敏和登录会话管理。

已进行实机启动、官方登录、房间创建及退出验证。全局计数需要用户完成系统授权；双人联机、宝箱领取、合成、兑换码和多显示器组合仍需进一步实机验证。后几项沿用官方界面和服务，不在本地模拟发奖。

应用内的官方更新接口目前仅提供 Windows 包，Mac 版本请从本仓库 Releases 更新，不能安装官方 EXE。

## 从源码构建

需要 macOS、Xcode Command Line Tools、Node.js 24、Rust（版本由 `rust-toolchain.toml` 固定）和 7-Zip。

```bash
xcode-select --install
brew install node@24 sevenzip
git clone https://github.com/Last-emo-boy/wuwa-tappo-mac.git
cd wuwa-tappo-mac
npm ci
npm run setup
npm test
npm run test:rust
npm run build
npm run package
```

`setup` 按 `upstream-cn.json` 下载锁定的国服官方安装包、校验完整性、静态提取资源并准备构建。整个过程不执行 Windows 程序，也不需要登录账号。若已下载对应安装包，可改用：

```bash
npm run assets:sync -- --installer "$HOME/Downloads/WuwaTappo-cn_1.0.0_x64-setup.exe"
npm run icons
npm run prepare:frontend
```

构建后的应用位于 `src-tauri/target/release/bundle/macos/`，完整分发包位于 `dist/`。`frontend/`、`build/`、`dist/` 与本地工作缓存不会提交到源码仓库，官方资源在构建时取得并嵌入最终安装包。

## CI/CD 与官方版本同步

- **提交 / Pull Request：** 下载锁定资源，运行 JavaScript 与 Rust 测试，构建并验证 Apple Silicon 应用，上传完整 ZIP / DMG 构建产物。
- **版本发布：** 推送 `v*` 标签（如 `v1.0.0-mac.1`）后执行同样检查，通过后发布到 GitHub Releases；也支持手动发布。
- **官方同步：** 每天检查国服官方更新。检测到新版本后尝试同步、测试和打包；兼容检查通过才创建更新 PR，失败则提交问题供维护者处理，不将未经适配的新版本直接推给用户。

维护者可以先在本地检查或同步上游：

```bash
npm run upstream:check
npm run upstream:update
npm run setup
npm test
npm run test:rust
npm run build
```

## 隐私与许可

发行包不包含维护者的登录凭据、钥匙串内容、账号缓存、点击记录或日志。选择「仅本次会话」时不把登录凭据写入钥匙串；选择记住登录时由系统钥匙串保存。输入监听用于响应按键/点击，原生后端不记录输入的正文。

本仓库原创的 macOS 后端与适配工具采用 [MIT 许可](LICENSE)。官方界面、角色、美术、音频等资源及第三方依赖保留各自权利与许可，**不因随包分发而转为 MIT 授权**。详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
