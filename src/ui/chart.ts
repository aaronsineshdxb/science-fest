import type { HistorySample } from '../sim/types';

const WINDOW_MIN = 180;

/** Compact chart: rainfall bars from the top, stored volume as an area below. */
export class Chart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  draw(samples: HistorySample[]): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.clearRect(0, 0, w, h);
    if (samples.length < 2) return;

    const now = samples[samples.length - 1].minutes;
    const from = now - WINDOW_MIN;
    const view = samples.filter((s) => s.minutes >= from);
    if (view.length < 2) return;

    const maxIntensity = Math.max(12, ...view.map((s) => s.intensity));
    const cap = Math.max(1, ...view.map((s) => s.storedCapacity));
    const barW = w / view.length;

    // Grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1 * dpr;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((h * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Stored volume.
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < view.length; i++) {
      const x = i * barW;
      const y = h - (view[i].stored / cap) * h * 0.92;
      ctx.lineTo(x, y);
    }
    ctx.lineTo((view.length - 1) * barW, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(86,217,200,0.34)');
    grad.addColorStop(1, 'rgba(86,217,200,0.03)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < view.length; i++) {
      const x = i * barW;
      const y = h - (view[i].stored / cap) * h * 0.92;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(120,235,216,0.95)';
    ctx.lineWidth = 1.4 * dpr;
    ctx.stroke();

    // Rainfall bars, hanging from the top.
    for (let i = 0; i < view.length; i++) {
      const s = view[i];
      const bh = (s.intensity / maxIntensity) * h * 0.55;
      if (bh <= 0.5) continue;
      ctx.fillStyle = 'rgba(58,168,216,0.55)';
      ctx.fillRect(i * barW + barW * 0.18, 0, Math.max(1 * dpr, barW * 0.64), bh);
    }

    // Scale labels.
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(`${maxIntensity.toFixed(0)} mm/h`, 4 * dpr, 3 * dpr);
    ctx.textBaseline = 'bottom';
    const pct = Math.round((view[view.length - 1].stored / cap) * 100);
    ctx.fillText(`stored ${pct}%`, w - ctx.measureText(`stored ${pct}%`).width - 4 * dpr, h - 3 * dpr);
  }
}
