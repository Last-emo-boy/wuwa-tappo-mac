# Wuwa Tappo · macOS

[简体中文](README.md) · **English**

[![Build](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml/badge.svg)](https://github.com/Last-emo-boy/wuwa-tappo-mac/actions/workflows/ci.yml)
[![Download](https://img.shields.io/github/v/release/Last-emo-boy/wuwa-tappo-mac?label=download)](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)

**Wuwa Tappo for Mac, for both the CN and Global servers.** It keeps each server's interface, character assets and official services, and replaces the Windows backend with a native macOS backend rebuilt in Rust and Tauri. No Wine, Windows or virtual machine is needed.

This is an **unofficial, community-maintained macOS port**. The CN and Global versions are packaged separately. Both currently match official **1.0.3**, and each one checks for and follows its own official updates.

## Download and use

Go to the **[latest release](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/latest)**, pick the `.dmg` for the region your account belongs to, drag the app into Applications and open it. You can also download the matching `.zip` and unzip it.

| Server region | App | Installer prefix |
| --- | --- | --- |
| CN | **Wuwa Tappo CN Mac.app** | `WuwaTappo-CN-Mac` |
| Global | **Wuwa Tappo Global Mac.app** | `WuwaTappo-Global-Mac` |

Both apps can be installed at the same time. Each keeps its own login, settings, counts and Keychain entries, and account data is never moved between them.

- **System:** Apple Silicon (M series), macOS 13 or later. There is no Intel version yet.
- **Complete assets:** Each installer includes its region's interface and bundled assets, so you don't need to download or extract the EXE separately. Login, asset updates and online features still need an internet connection.
- **First launch:** The current version is not notarized by Apple. If macOS blocks it, go to System Settings → Privacy & Security, confirm the source and choose **Open Anyway**. You don't need to turn off System Integrity Protection.
- **Input Monitoring:** In System Settings → Privacy & Security → Input Monitoring, add the app you use and turn it on. Each server's app needs its own permission. Quit and reopen the app when macOS asks; the pet responds to global keyboard and mouse input only after that.
- **Login:** CN uses the official login screen inside the app. Global uses the official browser login, which then returns to the app. On first launch you can choose **This session only**, or have the Keychain remember your login.

To update, quit the old version first, then replace the app of the same name in Applications. Don't run several copies at once. If the pet doesn't respond to input after an update, check the Input Monitoring permission; if needed, remove the old entry, add the latest version again and restart the app.

## Features and current status

- Transparent pet window, display placement, scaling, always on top and click-through.
- Native keyboard and mouse listening, input permission status, and listening that resumes after permission is granted.
- Custom native global shortcuts: by default `F7` toggles game mode, `F8` switches screens and `F9` hides or shows the pet. To change one, click the shortcut box next to the action in Settings. Mac modifier keys show as Ctrl, Option, Shift and Cmd. If both servers' apps run at the same time, give one of them different shortcuts to avoid system-wide conflicts.
- With **Enter game mode on full screen** turned on in Settings, the app detects when another app goes full screen and puts the pet into game mode, then leaves game mode when full screen ends.
- Gamepad button press counting and clap feedback, using the official counting rules.
- Click counts are saved locally, kept separate per app, account and server environment, and synced with the official sync protocol.
- Each server's official login, original panels, and character and item screens.
- Native WebSocket online connection, room creation and leaving.
- Menu bar controls, launch at login, log redaction and login session management.

CN has been tested on a real Mac for launch, official login, and creating and leaving rooms. Global has been tested for launch and the About and Settings panels; the official browser login redirect, the callback with a real account, and two-player online play still need testing on a real Mac. On both servers, counting system-wide keyboard and mouse input needs system permission. Gamepad support uses the system GameController framework and still needs testing with a real controller. Chest claiming, crafting, redeem codes and multi-display setups have not been fully tested on a real Mac. These features use the official interface and services; rewards are never simulated locally.

The official update service in the app currently offers only Windows packages. Update the Mac version from this repository's Releases; the official EXE cannot be installed.

## Build from source

You need macOS, Xcode Command Line Tools, Node.js 24, [rustup](https://rustup.rs/) (the Rust version is pinned by `rust-toolchain.toml`) and 7-Zip.

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

These commands build CN by default, and the existing entry points are unchanged. To build Global:

```bash
export WUWA_REGION=global
npm run setup
npm test
npm run test:rust
npm run build
npm run package
```

To switch back to CN, run `export WUWA_REGION=cn`. Shortcut commands such as `npm run setup:global` and `npm run build:global` also work, but tests still need the matching `WUWA_REGION`.

`setup` downloads the pinned official installer listed in `upstream-cn.json` or `upstream-global.json`, verifies its integrity, extracts the assets statically and prepares the build. It never runs a Windows program and doesn't need an account login. If you have already downloaded the installer, you can use this instead (CN as the example):

```bash
export WUWA_REGION=cn
npm run assets:sync -- --installer "$HOME/Downloads/WuwaTappo-cn_1.0.3_x64-setup.exe"
npm run icons
npm run prepare:frontend
```

The built app is in `src-tauri/target/release/bundle/macos/`, and the full distribution packages are in `dist/`. CN uses `frontend/` and Global uses `frontend-global/`; the two servers also have separate staging folders and icons. Asset folders, `build/`, `dist/` and local caches are not committed to the source repository. Official assets are fetched at build time and embedded in the final installer.

## CI/CD and official version sync

- **Commits and pull requests:** CN and Global each run the download, JavaScript and Rust tests, the native build, and full ZIP and DMG packaging. Build output and caches are kept separate per region.
- **Releases:** Pushing a `v*` tag (such as `v1.0.3-mac.1`) runs the checks for both servers. Only when all of them pass are the four installers published to a single Release. Manual releases are also supported.
- **Official sync:** Each server's official updates are checked once a day. When the compatibility checks and packaging pass, an update PR is opened. When extraction works but the port isn't adapted yet, a draft PR is opened with the API differences and failure logs. Repeated failures open an issue for that region, and unverified versions are never released automatically.
- **Build sources:** Verified installers are cached per region and official asset lock, and their integrity is checked again on every reuse. Without a cache, CI downloads from the official source first. If transient network errors use up all retries, it can use the original package from this repository's [build source mirror](https://github.com/Last-emo-boy/wuwa-tappo-mac/releases/tag/upstream-resources), pinned by the official SHA-256, and still checks the size and digest in the original lock. Discovering official versions and locking new assets always use the official source. The mirror files are not a way to install the Mac app.

Maintainers can check or sync the upstream for a chosen region locally (CN by default; for Global, set `WUWA_REGION=global` first):

```bash
npm run upstream:check
npm run upstream:update
npm run setup
npm test
npm run test:rust
npm run build
```

## Privacy and license

Release packages contain none of the maintainer's login credentials, Keychain contents, account cache, click records or logs. With **This session only**, login credentials are not written to the Keychain; if you choose to remember your login, the system Keychain stores it. Input listening is used to react to key presses and clicks, and the native backend does not record what you type.

The original macOS backend and porting tools in this repository are under the [MIT License](LICENSE). Official interface, character, art, audio and other assets, and third-party dependencies, keep their own rights and licenses, and **are not relicensed under MIT by being distributed in the package**. See the [third-party notices](THIRD_PARTY_NOTICES.md).
