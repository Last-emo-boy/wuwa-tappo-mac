# Wuwa Tappo · macOS

[![构建](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml/badge.svg)](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml)
[![下载](https://img.shields.io/github/v/release/Last-emo-boy/wuwa-tappo-mac?label=下载)](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)

**把 Wuwa Tappo 国服和国际服带到 Mac。** 保留各服界面、角色资源和官方服务，使用 Rust + Tauri 重建 macOS 原生后端，不需要 Wine、Windows 或虚拟机。

这是社区维护的**非官方 macOS 适配版**。国服和国际服分别打包，目前均对齐官方 **1.0.2**，各自检查和跟进官方更新。

## 下载与使用

前往 **[最新版本](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)**，按账号所属地区选择 `.dmg`，将应用拖入「应用程序」后打开。也可下载对应的 `.zip` 解压安装。

| 服务区域 | 应用 | 安装包前缀 |
| --- | --- | --- |
| 国服 | **Wuwa Tappo CN Mac.app** | `WuwaTappo-CN-Mac` |
| 国际服 | **Wuwa Tappo Global Mac.app** | `WuwaTappo-Global-Mac` |

两个应用可以同时安装，登录、设置、计数和钥匙串条目分别保存，不互相迁移账号数据。

- **系统：** Apple Silicon（M 系列），macOS 13 或更高版本。暂未提供 Intel 版本。
- **完整资源：** 各安装包包含对应地区的界面与内嵌资源，不需要另行下载或提取 EXE。登录、资源更新及在线功能仍需要联网。
- **首次打开：** 当前版本未经过 Apple 公证；如 macOS 阻止打开，请在「系统设置 → 隐私与安全性」中确认来源后选择「仍要打开」。无需关闭系统安全保护。
- **输入监控：** 在「系统设置 → 隐私与安全性 → 输入监控」中添加并开启所用的应用。两服需要分别授权；按系统提示退出并重新打开后，桌宠才能响应全局键盘和鼠标输入。
- **登录：** 国服使用官方内嵌登录界面，国际服使用官方浏览器登录并返回应用。首次启动可选择「仅本次会话」或通过钥匙串记住登录。

更新时先退出旧版，再覆盖「应用程序」中的同名应用；不要同时运行多个副本。若更新后桌宠不响应输入，请检查输入监控权限，必要时移除旧条目、重新添加最新版并重启应用。

## 功能与当前状态

- 透明桌宠窗口、显示器定位、缩放、置顶与鼠标穿透。
- 原生键盘/鼠标监听、输入权限状态提示与授权后的监听恢复。
- 手柄按钮按下统计与拍手反馈，沿用官方 1.0.2 的计数规则。
- 点击计数本地保存，按应用、账号和服务环境隔离，并沿用官方同步协议。
- 各服官方登录、原有面板、角色与物品界面。
- 原生 WebSocket 联机连接、房间创建与退出。
- 菜单栏控制、开机启动、日志脱敏和登录会话管理。

国服此前已进行实机启动、官方登录、房间创建及退出验证。国际服已验证启动、About 与设置面板；官方浏览器登录跳转、真实账号回调和双人联机仍需实机验收。两服的全局键鼠计数均需要系统授权；手柄功能使用系统 GameController 接口，仍需真实手柄验证。宝箱领取、合成、兑换码和多显示器组合尚未完成全面实机验证。相关功能沿用官方界面和服务，不在本地模拟发奖。

应用内的官方更新接口目前仅提供 Windows 包，Mac 版本请从本仓库 Releases 更新，不能安装官方 EXE。

## 从源码构建

需要 macOS、Xcode Command Line Tools、Node.js 24、[rustup](https://rustup.rs/)（Rust 版本由 `rust-toolchain.toml` 固定）和 7-Zip。

```bash
xcode-select --install
brew install node@24 sevenzip
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone https://github.com/Last-emo-boy/wuwa-tappo-mac.git
cd wuwa-tappo-mac
npm ci
npm run setup
npm test
npm run test:rust
npm run build
npm run package
```

以上命令默认构建国服，现有入口不变。构建国际服时使用：

```bash
export WUWA_REGION=global
npm run setup
npm test
npm run test:rust
npm run build
npm run package
```

切回国服时执行 `export WUWA_REGION=cn`。也可用 `npm run setup:global`、`npm run build:global` 等快捷命令，但测试仍需指定对应的 `WUWA_REGION`。

`setup` 按对应的 `upstream-cn.json` 或 `upstream-global.json` 下载锁定的官方安装包、校验完整性、静态提取资源并准备构建。整个过程不执行 Windows 程序，也不需要登录账号。若已下载对应安装包，可改用（以国服为例）：

```bash
export WUWA_REGION=cn
npm run assets:sync -- --installer "$HOME/Downloads/WuwaTappo-cn_1.0.2_x64-setup.exe"
npm run icons
npm run prepare:frontend
```

构建后的应用位于 `src-tauri/target/release/bundle/macos/`，完整分发包位于 `dist/`。国服使用 `frontend/`，国际服使用 `frontend-global/`；两服的准备目录与图标也分开。资源目录、`build/`、`dist/` 与本地缓存不提交到源码仓库，官方资源在构建时取得并嵌入最终安装包。

## CI/CD 与官方版本同步

- **提交 / Pull Request：** 国服与国际服分别执行下载、JavaScript / Rust 测试、原生构建与完整 ZIP / DMG 打包，构建产物和缓存按区域隔离。
- **版本发布：** 推送 `v*` 标签（如 `v1.0.2-mac.1`）后执行双服检查；全部通过才向同一个 Release 发布四个安装包。也支持手动发布。
- **官方同步：** 每天分别检查两服官方更新。兼容检查与打包通过后创建更新 PR；提取成功但尚未适配时创建草稿 PR，并保存接口差异与失败日志。已验证的安装包按地区与官方资源锁缓存，每次复用仍校验完整性。网络错误会有限重试，持续失败时提交对应地区的问题；未经验证的版本不会自动发布。

维护者可在本地检查或同步选定地区的上游（默认国服，国际服先设置 `WUWA_REGION=global`）：

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
