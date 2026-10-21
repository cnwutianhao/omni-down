# OmniDown ⬇️

一个基于 **Electron + WebTorrent** 的全能下载器：BT 磁力链接 + HTTP 直链双引擎。
支持 **macOS / Windows / Linux** 三平台。

## 功能

- ✅ 粘贴链接即下载：HTTP/HTTPS 直链、磁力链接、40 位 info hash 混贴均可（一次多个）
- ✅ 打开或拖入 `.torrent` 文件（支持多选）
- ✅ 拖动磁力链接文本到窗口即可添加
- ✅ 实时进度环、下载/上传速度、连接数、剩余时间（动态单位：天/小时/分/秒）
- ✅ 暂停 / 继续任务
- ✅ **全局限速**（下载/上传分别设置，重启保留）
- ✅ **文件选择下载**（多文件任务可勾选只下需要的文件）
- ✅ **边下边播**（下载中即可用系统播放器播放，本地 HTTP 流媒体）
- ✅ 卡住原因智能提示（死种/分享者离线/带宽受限自动诊断）
- ✅ 自定义下载目录（记忆上次选择）
- ✅ 在访达中打开 / 显示文件
- ✅ 移除任务（可选是否删除已下载文件）
- ✅ 退出后自动保存任务列表，下次启动自动恢复
- ✅ ⌘V 自动识别剪贴板中的磁力链接
- ✅ 点击任务名可复制磁力链接

## 开发运行

```bash
npm install
npm start
```

## 打包成桌面应用

```bash
npm run dist        # macOS：生成 OmniDown.app（release/mac/）
npm run dist-dmg    # macOS：生成 .dmg 安装包
npm run dist:win    # Windows：生成 NSIS 安装包（需在 Windows 上执行）
npm run dist:linux  # Linux：生成 AppImage + deb（需在 Linux 上执行）
```

> Electron 不支持交叉打包：Windows 安装包要在 Windows 上打，Linux 包要在 Linux 上打。
> 也可以用 GitHub Actions 在三个平台上自动打包。

打包完成后把 `release/mac/OmniDown.app` 拖到 `/Applications` 即可双击使用。

## 项目结构

```
src/
├── main/
│   ├── main.js            # Electron 主进程：窗口、IPC、系统集成
│   └── torrent-engine.js  # BT 引擎：基于 WebTorrent，负责下载/状态/持久化
├── preload/
│   └── preload.cjs        # 安全桥接（contextBridge）
└── renderer/
    ├── index.html         # 界面结构
    ├── styles.css         # 深色玻璃拟态样式
    └── renderer.js        # 界面逻辑
```

## 数据存放位置

- 任务列表：`~/Library/Application Support/OmniDown/torrents.json`
- 设置：`~/Library/Application Support/OmniDown/settings.json`
- 默认下载目录：`~/Downloads/OmniDown`

## 说明

- 内置 8 个公共 tracker，并启用 DHT，有助于提高找 peer 的成功率。
- 下载速度取决于种子的健康度（种子数/做种人数），冷门资源可能很慢甚至下不动。
- 仅供学习与个人合法用途，请勿用于下载侵犯版权的内容。
