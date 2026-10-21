/**
 * 磁盘空间监控（借鉴 qBittorrent FreeDiskSpaceChecker + FREEDISKSPACE_CHECK_TIMEOUT=30s）
 * 周期检查下载目录剩余空间，低于阈值时通知 UI 警告。
 */
import fs from 'node:fs';
import os from 'node:os';

const CHECK_INTERVAL_MS = 30_000; // qBittorrent: 30s
const WARN_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024; // 剩余 < 2GB 警告
const CRITICAL_THRESHOLD_BYTES = 500 * 1024 * 1024; // 剩余 < 500MB 严重

export class DiskSpaceMonitor {
  constructor(paths) {
    this.paths = paths || [];
    this.timer = null;
    this.last = { free: 0, total: 0, level: 'ok' }; // level: ok | warn | critical
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPaths(paths) {
    this.paths = paths || [];
    this.check();
  }

  check() {
    const target = this.paths[0];
    if (!target) return;
    try {
      const s = fs.statfsSync(target);
      const free = s.bavail * s.bsize;
      const total = s.blocks * s.bsize;
      const level =
        free < CRITICAL_THRESHOLD_BYTES ? 'critical' : free < WARN_THRESHOLD_BYTES ? 'warn' : 'ok';
      const prev = this.last;
      this.last = { free, total, level };
      // 状态变化时通知
      if (prev.level !== level) {
        this.onChange?.(this.last);
      }
    } catch {
      /* 目录可能暂时不可访问 */
    }
  }

  /** 人类可读的摘要，供状态栏显示 */
  summary() {
    const { free, total, level } = this.last;
    const gb = (n) => `${(n / 1024 ** 3).toFixed(0)} GB`;
    return { ...this.last, text: `磁盘剩余 ${gb(free)} / ${gb(total)}` };
  }
}
