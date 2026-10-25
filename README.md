# OmniDown ⬇️

一个基于 Electron + WebTorrent 的全能下载器：BT 磁力链接 + HTTP 直链双引擎。
完整支持 macOS / Windows / Linux 三平台，界面与功能一致，仅系统集成细节随平台自动适配
（详见「[平台适配](#平台适配)」）。

## 功能

- ✅ 粘贴链接即下载：HTTP/HTTPS 直链、磁力链接、40 位 info hash 混贴均可（一次多个）
- ✅ 打开或拖入 `.torrent` 文件（支持多选）
- ✅ 拖动链接文本到窗口即可添加（磁力 / HTTP 直链均可）
- ✅ 实时进度环、下载/上传速度、连接数、剩余时间（动态单位：天/小时/分/秒）
- ✅ 暂停 / 继续任务，HTTP 任务支持断点续传
- ✅ 全局限速（下载/上传分别设置，重启保留，同时作用于 BT 与 HTTP）
- ✅ 文件选择下载（多文件任务可勾选只下需要的文件）
- ✅ 边下边播（下载中即可用系统播放器播放，本地 HTTP 流媒体）
- ✅ 卡住原因智能提示（死种/分享者离线/带宽受限自动诊断）
- ✅ 速度图表（5 分钟 / 30 分钟 / 6 小时 / 12 小时 / 24 小时五档时间窗）
- ✅ 磁盘剩余空间监控（低于 2GB 警告、低于 500MB 严重告警）
- ✅ 做种限制（按分享率或做种时长自动停止 / 移除）
- ✅ 自定义下载目录（记忆上次选择）
- ✅ 打开所在文件夹 / 定位文件（macOS 访达 · Windows 资源管理器 · Linux 默认文件管理器）
- ✅ 移除任务（可选是否删除已下载文件）
- ✅ 退出后自动保存任务列表，下次启动自动恢复
- ✅ ⌘V（macOS）/ Ctrl+V（Windows、Linux）自动识别剪贴板中的下载链接
- ✅ 点击任务名可复制下载链接（BT 复制磁力链接，HTTP 复制直链）

## 开发运行

```bash
npm install
npm start
```

> 需要 **Node.js ≥ 22**（WebTorrent 3.x 的 `engines` 要求，macOS / Windows / Linux 一致）。
> 实际运行时应用跑在 Electron 内置的 Node 上（Electron 33 → Node 20），已验证 WebTorrent 3.x 工作正常。
> 国内网络（npm / Electron 二进制）走 npmmirror 镜像，配置已在 `.npmrc` 里备好，无需额外设置。

### Linux 首次运行

Electron 在 Linux 上需要一批系统库（`libnss3`、`libgtk-3`、`libgbm`、`libasound2` 等）。
Ubuntu / Debian 上如遇启动失败，先装一遍：

```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libpangocairo-1.0-0
```

## 测试

测试脚本不用测试框架，直接 `node scripts/xxx.mjs` 运行。

| 脚本 | 覆盖内容 |
|---|---|
| `repro-p0-p1.mjs` | 并发保存崩溃 / 小限速死锁 / 图表时间窗 / deselected 恢复 |
| `repro-schedule-restart.mjs` | 批量添加不突破并发上限 / stop 后再 start 能恢复 |
| `http-engine-test.mjs` | HTTP 引擎：分块、断点续传、限速、重名、错误处理、持久化 |
| `qb-features-test.mjs` | 磁盘监控 / 速度历史 / 做种限制 |
| `verify-features.mjs` | BT 文件选择 / 流媒体服务器 |
| `stability-test.mjs` | HTTP 引擎 N 轮混合场景压测（默认 100 轮） |
| `ui-test.mjs` / `ui-test-features.mjs` | UI 自动化（需以 `--remote-debugging-port=9222` 启动应用） |
| `ui-stress.mjs` | 桌面端端到端压测（真实 UI 操作、并发与暂停、内存/DOM 趋势） |

改引擎代码后至少跑：

```bash
node scripts/repro-p0-p1.mjs && node scripts/repro-schedule-restart.mjs && \
node scripts/http-engine-test.mjs && node scripts/stability-test.mjs 50
```

桌面端压测需要另起本地测试服务器和带调试端口的应用（用独立数据目录，不影响日常任务）：

```bash
node scripts/test-server.mjs 8 18090 &
./node_modules/.bin/electron . --remote-debugging-port=9222 --user-data-dir=/tmp/omnidown-stress-ud &
node scripts/ui-stress.mjs 200 18090
```

> `ui-test.mjs` / `ui-test-features.mjs` 需要公网 DHT/tracker 解析真实种子的元数据；
> `ui-stress.mjs` 只覆盖 HTTP 直链（本地测试服务器），不依赖外网。

## 打包成桌面应用

各平台分别打包（Electron 不支持交叉打包，见下方说明）：

```bash
npm run dist        # macOS：生成 OmniDown.app（release/mac/）
npm run dist-dmg    # macOS：生成 .dmg 安装包
npm run dist:win    # Windows：生成 NSIS 安装包（release/*.exe）
npm run dist:linux  # Linux：生成 AppImage + deb
```

> **为什么不能一个平台打三个包？**
> Electron 原生模块（含 `node-datachannel`）是按平台和 CPU 架构编译的二进制，
> electron-builder 无法交叉编译它们。因此 macOS / Windows / Linux 包都必须在对应系统上打。
>
> `npm run dist:all`（即 `electron-builder -mwl`）在 macOS 以外的系统上会直接报错退出
> （`Build for macOS is supported only on macOS`），遇到第一个不支持的目标就中止，
> 不会退化成「只打当前平台」。
>
> 想一次性产出三平台安装包，只能在三个系统上分别执行，或用 CI（如 GitHub Actions）
> 在各自的原生 runner 上并行构建 —— 但需要自备仓库和账号，本项目未附带工作流配置。

各平台安装方式：

| 平台 | 产物 | 安装 / 运行方式 |
|---|---|---|
| macOS | `release/mac/OmniDown.app`、`.dmg` | 把 `OmniDown.app` 拖到 `/Applications` 后双击；未签名版本首次运行需执行 `xattr -cr /Applications/OmniDown.app` |
| Windows | `release/*.exe`（NSIS） | 双击安装包按向导安装；未签名版本首次运行会被 SmartScreen 拦截，需点「更多信息 → 仍要运行」 |
| Linux | `release/*.AppImage`、`.deb` | AppImage：`chmod +x` 后直接运行；deb：`sudo dpkg -i <包名>.deb` |

## 项目结构

```
src/
├── main/
│   ├── main.js            # Electron 主进程：窗口、IPC、系统集成
│   ├── torrent-engine.js  # BT 引擎：基于 WebTorrent，负责下载/状态/持久化
│   ├── http-engine.js     # HTTP 直链引擎：多线程分块/断点续传/队列/限速
│   ├── disk-monitor.js    # 磁盘空间监控
│   └── speed-history.js   # 速度历史采样
├── preload/
│   └── preload.cjs        # 安全桥接（contextBridge）
└── renderer/
    ├── index.html         # 界面结构
    ├── styles.css         # 深色玻璃拟态样式
    ├── platform.js        # 平台标记（macOS / 其他，供 CSS 区分标题栏留白）
    └── renderer.js        # 界面逻辑
```

## 数据存放位置

用户数据目录（`app.getPath('userData')`）随平台不同：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/OmniDown/` |
| Windows | `%APPDATA%\OmniDown\` |
| Linux | `~/.config/OmniDown/` |

目录内文件：

- `torrents.json` — BT 任务列表
- `http-tasks.json` — HTTP 任务列表与分块进度
- `settings.json` — 下载目录、限速、做种限制

默认下载目录：系统「下载」目录下的 `OmniDown` 子目录
（`app.getPath('downloads')`，三平台自动解析，Windows 通常为 `C:\Users\<用户名>\Downloads\OmniDown`）。

## 平台适配

核心功能（BT / HTTP 下载、限速、文件选择、边下边播、任务持久化）三平台完全一致，
以下细节由 Electron 按平台自动适配，无需用户配置：

| 项目 | macOS | Windows | Linux |
|---|---|---|---|
| 最低系统版本 | macOS 13 Ventura（Intel / Apple Silicon） | Windows 10（x64） | Ubuntu 20.04 / Debian 11 / Fedora 32 及以上（x64，glibc ≥ 2.30） |
| 窗口标题栏 | 隐藏标题栏 + 左上角红绿灯（`titleBarStyle: hiddenInset`） | 系统原生标题栏 | 系统原生标题栏 |
| 打开所在文件夹 | 访达 Finder | 资源管理器 | 默认文件管理器（Nautilus / Dolphin / Thunar 等，取决于桌面环境） |
| 剪贴板自动识别 | ⌘V | Ctrl+V | Ctrl+V |
| 用户数据目录 | `~/Library/Application Support/OmniDown/` | `%APPDATA%\OmniDown\` | `~/.config/OmniDown/` |
| 默认下载目录 | `~/Downloads/OmniDown/` | `%USERPROFILE%\Downloads\OmniDown\` | `~/Downloads/OmniDown/` |
| 打包产物 | `.app` / `.dmg` | NSIS `.exe` | `.AppImage` / `.deb` |
| 应用图标 | `build/icon.png` | `build/icon.ico`（多尺寸） | `build/icon.png` |

> 界面字体栈已包含 macOS（`-apple-system` / `SF Pro Text` / `PingFang SC`）、
> Windows（`Segoe UI` / `Microsoft YaHei`）、Linux（回退到系统默认无衬线字体）三套。
> 空状态等图标使用内联 SVG 而非 emoji 字符，避免各平台 emoji 字体字形不一致。

Linux 首次运行可能缺少 Electron 依赖的系统库，见上方「[Linux 首次运行](#linux-首次运行)」。

### 重新生成图标

`build/icon.png` 是 master（2048px），`build/icon.ico` 由它派生。改了 PNG 后重新生成 Windows 图标：

```bash
node scripts/gen-icon-ico.mjs                              # 默认 build/icon.png → build/icon.ico
node scripts/gen-icon-ico.mjs path/to/src.png out.ico       # 也可指定路径
```

会输出 16 / 24 / 32 / 48 / 64 / 128 / 256 七种尺寸（256 用 PNG 条目，其余用 BMP），
这是 Windows 标题栏、任务栏、资源管理器、桌面所必需的——缺尺寸时系统会缩放导致发糊。
脚本纯 Node 实现（只用内置 `zlib`），三平台都能跑，无需安装依赖。

## 说明

- 内置 10 个公共 tracker（UDP / HTTP / WebSocket 混合），并启用 DHT，有助于提高找 peer 的成功率。
- 下载速度取决于种子的健康度（种子数/做种人数），冷门资源可能很慢甚至下不动。
- 仅供学习与个人合法用途，请勿用于下载侵犯版权的内容。
