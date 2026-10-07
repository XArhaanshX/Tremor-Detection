// Tiny canvas chart: bars / line / step series on ONE y-axis, vertical event
// markers, hover crosshair + tooltip. No dependencies, so the app works offline.
// Colours come from CSS custom properties so light/dark themes just work.

const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

export class Chart {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = { height: 220, yMin: 0, yMax: 4, yTicks: [0, 1, 2, 3, 4], yFormat: String, xFormat: String, xTicks: null, ...opts };
    this.data = { series: [], markers: [] };
    host.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    host.append(this.canvas, this.tip);
    this.pad = { l: 36, r: 12, t: 12, b: 26 };
    this.hoverX = null;
    new ResizeObserver(() => this.draw()).observe(host);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.tip.hidden = true; this.draw(); });
  }

  set(data) {
    this.data = { markers: [], ...data };
    if (data.ariaLabel) this.canvas.setAttribute('aria-label', data.ariaLabel);
    this.draw();
  }

  xToPx(x) { const { xMin, xMax } = this.data; return this.pad.l + ((x - xMin) / (xMax - xMin || 1)) * this.w; }
  yToPx(y) { const { yMin, yMax } = this.opts; return this.pad.t + (1 - (y - yMin) / (yMax - yMin)) * this.h; }

  draw() {
    const { host, canvas, opts, pad } = this;
    const width = host.clientWidth;
    if (!width) return;
    const height = opts.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    this.w = width - pad.l - pad.r;
    this.h = height - pad.t - pad.b;
    const ink = { grid: css(host, '--grid'), axis: css(host, '--axis'), muted: css(host, '--text-muted'), text: css(host, '--text-2') };
    g.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    // grid + y labels
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const y of opts.yTicks) {
      const py = Math.round(this.yToPx(y)) + 0.5;
      g.strokeStyle = y === opts.yMin ? ink.axis : ink.grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(pad.l, py); g.lineTo(pad.l + this.w, py); g.stroke();
      g.fillStyle = ink.muted;
      g.fillText(opts.yFormat(y), pad.l - 6, py);
    }
    const { xMin, xMax } = this.data;
    if (xMin == null) return;

    // x labels
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const ticks = opts.xTicks ? opts.xTicks(xMin, xMax, this.w) : [];
    for (const x of ticks) {
      const px = this.xToPx(x);
      if (px < pad.l - 1 || px > pad.l + this.w + 1) continue;
      g.fillStyle = ink.muted;
      g.fillText(opts.xFormat(x), px, pad.t + this.h + 7);
    }

    // event markers (doses, tests): dashed vertical rule + small label
    for (const m of this.data.markers) {
      const px = Math.round(this.xToPx(m.x)) + 0.5;
      if (px < pad.l || px > pad.l + this.w) continue;
      g.strokeStyle = css(host, m.color || '--text-2');
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(px, pad.t); g.lineTo(px, pad.t + this.h); g.stroke();
      g.setLineDash([]);
      if (m.label) {
        g.fillStyle = ink.text;
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(m.label, px + 3, pad.t);
      }
    }

    g.save();
    g.beginPath(); g.rect(pad.l, 0, this.w, height); g.clip();
    for (const s of this.data.series) this.drawSeries(g, s);
    g.restore();

    if (this.hoverX != null) {
      const px = Math.round(this.xToPx(this.hoverX)) + 0.5;
      g.strokeStyle = ink.axis;
      g.beginPath(); g.moveTo(px, pad.t); g.lineTo(px, pad.t + this.h); g.stroke();
    }
  }

  drawSeries(g, s) {
    const color = css(this.host, s.color);
    const base = this.yToPx(this.opts.yMin);
    if (s.type === 'bars') {
      const bw = Math.max(1, this.xToPx(this.data.xMin + s.barWidth) - this.xToPx(this.data.xMin) - 2);  // 2px gap
      g.fillStyle = color;
      for (const p of s.points) {
        if (p.y <= 0) continue;
        const x = this.xToPx(p.x) + 1;
        const top = this.yToPx(p.y);
        const r = Math.min(4, bw / 2, base - top);
        g.beginPath();
        g.moveTo(x, base); g.lineTo(x, top + r);
        g.arcTo(x, top, x + r, top, r); g.lineTo(x + bw - r, top);
        g.arcTo(x + bw, top, x + bw, top + r, r); g.lineTo(x + bw, base);
        g.closePath(); g.fill();
      }
      return;
    }
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    let prev = null;
    for (const p of s.points) {
      if (p.y == null) { prev = null; continue; }  // gap
      const x = this.xToPx(p.x), y = this.yToPx(p.y);
      if (!prev || (s.maxGap && p.x - prev.x > s.maxGap)) g.moveTo(x, y);
      else if (s.type === 'step') { g.lineTo(x, this.yToPx(prev.y)); g.lineTo(x, y); }
      else g.lineTo(x, y);
      prev = p;
    }
    g.stroke();
    if (s.dots) {
      g.fillStyle = color;
      for (const p of s.points) {
        if (p.y == null) continue;
        g.beginPath(); g.arc(this.xToPx(p.x), this.yToPx(p.y), 4, 0, 2 * Math.PI); g.fill();
      }
    }
  }

  onMove(e) {
    const s = this.data.series[0];
    if (!s || !s.points.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    // nearest point by x (bars are hit anywhere inside their slot)
    let best = null, bd = Infinity;
    for (const p of s.points) {
      const cx = this.xToPx(p.x + (s.type === 'bars' ? s.barWidth / 2 : 0));
      const d = Math.abs(cx - mx);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > 40) { this.tip.hidden = true; this.hoverX = null; this.draw(); return; }
    this.hoverX = best.x + (s.type === 'bars' ? s.barWidth / 2 : 0);
    this.draw();
    const html = this.data.tooltip ? this.data.tooltip(best) : `${this.opts.xFormat(best.x)}: ${this.opts.yFormat(best.y)}`;
    if (!html) { this.tip.hidden = true; return; }
    this.tip.innerHTML = html;
    this.tip.hidden = false;
    const tx = Math.min(Math.max(this.xToPx(this.hoverX) + 12, 0), this.host.clientWidth - this.tip.offsetWidth - 4);
    this.tip.style.left = `${Math.max(0, tx)}px`;
    this.tip.style.top = `${this.pad.t}px`;
  }
}

// ---- axis helpers ----
export const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

export function timeTicks(xMin, xMax, widthPx) {
  const span = xMax - xMin;
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 86400e3];
  const maxTicks = Math.max(2, Math.floor(widthPx / 70));
  const step = steps.find((s) => span / s <= maxTicks) || 86400e3;
  const off = new Date(xMin).getTimezoneOffset() * 60e3;
  const out = [];
  for (let t = Math.ceil((xMin - off) / step) * step + off; t <= xMax; t += step) out.push(t);
  return out;
}
