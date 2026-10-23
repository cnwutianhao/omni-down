# AGENTS.md — OmniDown 开发约定

> 本文件供 AI 编码助手（Copilot/Claude 等）和人类协作者阅读，定义项目的结构、约定与工作流。

## 项目概览

**OmniDown** — 跨平台全能下载器（BT 磁力 + HTTP 直链双引擎），Electron + WebTorrent。

- 运行时：Node.js ≥ 22（WebTorrent 3.x 要求），Electron 33
- 平台：macOS / Windows / Linux
- 语言：纯 JavaScript（ESM，`"type": "module"`），无 TypeScript、无构建步骤

## 依赖与安装（改依赖前必读）

- **`node-datachannel` 被 `overrides` 钉在 `0.33.4`，不要随意移除**。
  - `0.32.x` 及更早的 install 脚本是 `prebuild-install || (… prebuild)`：从 GitHub Releases 下载二进制。
    国内网络下载失败后会回退到已废弃的 `prebuild@13`，在 Node ≥ 22 上直接崩（`expected first argument to be an array`）。
  - `0.33.x` 改成 **npm 平台分包**（`@node-datachannel/linux-x64-gnu` 等），走 registry 而非 GitHub，不再有 install 脚本。
  - 它是 `webtorrent → @thaunknown/simple-peer → webrtc-polyfill` 的传递依赖，不会出现在 `dependencies` 里。
- `.npmrc` 里的 `electron_mirror` / `electron_builder_binaries_mirror` 不能删：国内直连 GitHub 会 `ECONNRESET`。
  npm 11 会对这两个非标准键打 `Unknown project config` 警告，属预期行为。
- `.npmrc` 的 `cache` 用 `~` 展开，不要改回绝对路径（mac 上写死的 `/Users/...` 在 Linux 会直接 EACCES）。
- `package.json` 的 `allowScripts` 是 npm 11 的脚本白名单，新增/升级带 install 脚本的包时要同步补条目。

## 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── main.js         # 入口：窗口、IPC 注册、引擎装配、数据迁移
│   ├── torrent-engine.js   # BT 引擎（WebTorrent 封装）：任务/做种限制/流媒体
│   ├── http-engine.js      # HTTP 直链引擎：多线程分块/断点续传/队列/限速
│   ├── disk-monitor.js     # 磁盘空间监控（30s 周期）
│   └── speed-history.js    # 速度历史采样（5 档时间窗）
├── preload/
│   └── preload.cjs     # contextBridge 安全桥接（唯一 .cjs，因主项目是 ESM）
└── renderer/
    ├── index.html      # 界面结构（含所有弹窗模板）
    ├── styles.css      # 样式（深色主题，CSS 变量在 :root）
    └── renderer.js     # 界面逻辑（无框架，原生 DOM）
scripts/               # 测试与诊断脚本（node 直接运行，见下）
build/                 # 打包资源：icon.png (mac/linux)、icon.ico (win)
```

## 核心约定

### 双引擎架构

- 所有任务统一呈现在一个列表，靠 `task.kind` 区分：`'http'` 或 BT（无 kind 字段）
- **新增任务相关 IPC 必须考虑双引擎路由**：参考 `main.js` 里 `t:pause`/`t:remove` 的写法（先查 `httpEngine.tasks.get(hash)`，命中走 HTTP 引擎，否则走 BT 引擎）
- UI 状态聚合在 `mergedState()`（main.js 模块级），两个引擎的 `update` 事件都转发到它

### WebTorrent 3.x 的坑（改引擎代码前必读）

- `client.get(id)` 是 **async**；同步查找用 `engine._torrentOf(hash)`（遍历 `client.torrents`）
- `torrent.infoHash` 在 `_infoHash` 事件后才可用，`client.add()` 返回时是 undefined
- `torrent.timeRemaining` 单位是**毫秒**，序列化时除以 1000
- 文件级 `progress` 可能为负数，必须 clamp 到 [0,1]
- 流媒体：`client.createServer()`（在 client 上，不在 torrent 上）；URL 路径必须匹配 `file.path`（含目录）

### 状态持久化

- 两个引擎各自持久化：BT → `torrents.json`，HTTP → `http-tasks.json`（userData 目录）
- **必须原子写**：先写 `.tmp` 再 `rename`，且 `_saveState` 有 `_saving` 互斥锁（并发写会损坏文件，已踩过坑）
- HTTP 引擎的 `.part` 文件是断点续传载体，删除任务时记得清理

### UI 文案

- 中性场景用「链接 / 任务 / 下载」；**只有 BT 专属语境才用**「磁力 / 种子 / 做种」
- 复制按钮等按任务类型区分文案（HTTP → 下载链接，BT → 磁力链接）
- 卡住的任务要给诊断提示（`renderer.js` 的 hint 逻辑）

### 平台兼容

- 窗口配置按 `process.platform` 分支（mac: hiddenInset 红绿灯；win/linux: 原生标题栏）
- CSS 用 `html[data-platform]` 区分标题栏留白
- 字体栈必须包含 Segoe UI / Microsoft YaHei（Windows）
- 不要引入 macOS 专属 API（osascript 等）；`shell.*` 是跨平台的，放心用

## 测试

所有测试脚本直接 `node scripts/xxx.mjs` 运行，无需测试框架：

| 脚本 | 用途 |
|---|---|
| `stability-test.mjs` | **改引擎后必跑**：N 轮混合场景压测（默认 100） |
| `http-engine-test.mjs` | HTTP 引擎 17 项功能测试 |
| `qb-features-test.mjs` | 磁盘监控/速度历史/做种限制 15 项 |
| `verify-features.mjs` | BT 文件选择/流媒体验证 |
| `repro-p0-p1.mjs` | 并发保存崩溃/小限速死锁/图表时间窗/deselected 恢复 4 项回归 |
| `repro-schedule-restart.mjs` | HTTP 批量添加不突破并发上限 / stop 后再 start 能恢复 7 项回归 |
| `ui-test.mjs` / `ui-test-features.mjs` | UI 自动化（需 `--remote-debugging-port=9222` 启动应用） |
| `test-server.mjs` | 本地测试 HTTP 服务器（压测依赖） |

改完引擎代码的最小验证集：
```bash
node scripts/repro-p0-p1.mjs && node scripts/repro-schedule-restart.mjs && node scripts/http-engine-test.mjs && node scripts/stability-test.mjs 50
```

## 打包

```bash
npm run dist        # mac（本机架构）
npm run dist:win    # Windows（需在 Windows 上跑）
npm run dist:linux  # Linux（需在 Linux 上跑）
```

- 国内网络需要：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- Electron 不支持交叉打包（原生模块），各平台各自打
- 图标：`build/icon.png`（2048px master，8-bit RGBA）/ `build/icon.ico`（Windows，含 16/24/32/48/64/128/256 七种尺寸）
  - `scripts/gen-icon-ico.mjs` 从 `icon.png` 重新生成多尺寸 ICO，**纯 Node 实现（只用内置 zlib），三平台都能跑**。
    Windows 的标题栏 / 任务栏 / 资源管理器 / 桌面分别取不同尺寸，ICO 缺尺寸时系统会缩放导致发糊。
  - `scripts/gen-icon.js` 是早期用 macOS `osascript` + Cocoa 画 master PNG 的脚本，**只能跑在 macOS 上**；
    在 Windows / Linux 上改图标请直接替换 `icon.png` 后再跑 `gen-icon-ico.mjs`。

## Git 提交规范

格式：`<type>: <一句话中文描述>`（小写 type，冒号后空格）

type 取值：
- `feat` 新功能
- `fix` 修复 bug
- `perf` 性能优化
- `refactor` 重构（不改行为）
- `docs` 文档
- `test` 测试相关
- `chore` 构建/工具/杂项

示例：
```
feat: HTTP 直链多线程分块下载引擎
fix: 修复并发保存导致状态文件损坏的问题
perf: 速度图表降采样到 120 点
docs: 补充跨平台打包说明
```

一次提交只做一件事；大功能拆成多个 commit。

- **提交与推送由人类执行**：AI 只按上述格式给出建议的消息文本，不自行 `git commit` / `git push`。
- **最小验证集按改动范围区分**（脚本清单见「测试」一节）：
  - 引擎 / IPC / 持久化改动：跑 `repro-p0-p1.mjs` + `repro-schedule-restart.mjs` + `http-engine-test.mjs` + `stability-test.mjs`
  - 纯渲染层改动（`styles.css` / `index.html` / 仅涉及样式与布局的 `renderer.js`）：启动应用目视确认即可，不必跑引擎测试

## 已知注意事项

- 国内网络：GitHub 直连不稳定；npm/Electron 二进制用 npmmirror 镜像（见 `.npmrc` 与 README）
- 应用未签名：macOS 分发需用户 `xattr -cr` 去隔离；Windows SmartScreen 会警告
- 用户数据目录：`app.getPath('userData')` — mac `~/Library/Application Support/OmniDown/`、
  Windows `%APPDATA%\OmniDown\`、Linux `~/.config/OmniDown/`（含从 TorrentFlow 的一次性迁移逻辑，勿删）
