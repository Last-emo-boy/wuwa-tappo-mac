# 第三方内容

## Wuwa Tappo 国服与国际服

本项目使用对应地区官方客户端的界面、角色、美术、音频、字体及其他内嵌资源，并通过该地区官方服务完成登录和业务请求。相关内容、名称和商标属于库洛及各自权利人，不适用本仓库的 MIT 许可。

- 国服下载入口：https://download-mc-wuwatappo.kurogames-global.com/download/
- 国际服下载入口：https://download-wutheringwaves-wuwatappo.kurogames-global.com/download/en/
- 构建所用版本、下载地址和完整性校验：[`upstream-cn.json`](upstream-cn.json)、[`upstream-global.json`](upstream-global.json)

安装包在构建时从官方客户端提取资源并完整打包；源代码仓库不存放个人账号数据。使用本项目仍需遵守官方服务条款。本项目由社区维护，与官方发行渠道独立。

## Preact

`tests/fixtures/kuro-sdk-preact.js` 中的渲染器测试代码使用 Preact，采用 MIT 许可；完整版权与许可声明保留在该文件头部。

## 构建依赖

Tauri、Rust crates、Node.js 包及 7-Zip 采用各自许可。依赖版本分别记录在 `src-tauri/Cargo.lock` 与 `package-lock.json`；7-Zip 仅用于构建时静态解包，不随应用分发。
