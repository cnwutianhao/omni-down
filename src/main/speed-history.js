/**
 * 速度历史采样器（借鉴 qBittorrent speedplotview.h 的 Averager 设计）
 * 5 档时间窗：5分(1s采样) / 30分(6s) / 6时(36s) / 12时(72s) / 24时(144s)
 * 每档维护环形缓冲，UI 按需取对应窗口绘制。
 */
const WINDOWS = [
  { key: '5m', label: '5 分钟', spanMs: 5 * 60_000, sampleMs: 1_000 },
  { key: '30m', label: '30 分钟', spanMs: 30 * 60_000, sampleMs: 6_000 },
  { key: '6h', label: '6 小时', spanMs: 6 * 3_600_000, sampleMs: 36_000 },
  { key: '12h', label: '12 小时', spanMs: 12 * 3_600_000, sampleMs: 72_000 },
  { key: '24h', label: '24 小时', spanMs: 24 * 3_600_000, sampleMs: 144_000 }
];

export class SpeedHistory {
  constructor() {
    /** key -> [{ t, down, up }] */
    this.buffers = new Map(WINDOWS.map((w) => [w.key, []]));
    this._acc = { down: 0, up: 0, n: 0, since: Date.now() };
  }

  /** 每秒由外部喂入当前速度（字节/秒）；nowMs 可注入用于测试 */
  push(downBps, upBps, nowMs) {
    const now = nowMs ?? Date.now();
    this._acc.down += downBps;
    this._acc.up += upBps;
    this._acc.n += 1;

    const elapsed = now - this._acc.since;
    // 到达最小采样窗（1s）时，结算一次平均值并写入所有窗口
    if (elapsed >= WINDOWS[0].sampleMs) {
      const avgDown = Math.round(this._acc.down / this._acc.n);
      const avgUp = Math.round(this._acc.up / this._acc.n);
      for (const w of WINDOWS) {
        // 高档位窗口按自己的采样间隔稀疏写入
        if (elapsed < w.sampleMs && w.key !== WINDOWS[0].key) continue;
        const buf = this.buffers.get(w.key);
        buf.push({ t: now, down: avgDown, up: avgUp });
        const cutoff = now - w.spanMs;
        while (buf.length && buf[0].t < cutoff) buf.shift();
      }
      this._acc = { down: 0, up: 0, n: 0, since: now };
    }
  }

  /** 取某窗口的数据（默认降采样到 ~120 点供绘图） */
  series(key, maxPoints = 120) {
    const buf = this.buffers.get(key) || [];
    if (buf.length <= maxPoints) return buf;
    const step = buf.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
      out.push(buf[Math.floor(i * step)]);
    }
    return out;
  }

  windows() {
    return WINDOWS.map(({ key, label }) => ({ key, label }));
  }
}
