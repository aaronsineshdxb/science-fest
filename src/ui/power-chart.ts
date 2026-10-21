import type { HistorySample } from '../sim/types';

const WINDOW_MIN = 180;

/**
 * The district grid over the last three hours: solar and hydro stacked as
 * the generation mix, with the demand line drawn over the top.
 */
export class PowerChart {
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
    const view = samples.filter((s) => s.minutes >= now - WINDOW_MIN);
    if (view.length < 2) return;

    const peak = Math.max(
      1,
      ...view.map((s) => Math.max(s.solarKw + s.hydroKw, s.demandKw)),
    );
    const barW = w / view.length;
    const base = h;

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

    // Generation: solar under hydro, as a stacked area.
    const area = (top: (s: HistorySample) => number, color: string) => {
      ctx.beginPath();
      ctx.moveTo(0, base);
      for (let i = 0; i < view.length; i++) {
        const x = i * barW;
        const y = base - (top(view[i]) / peak) * h * 0.92;
        ctx.lineTo(x, y);
      }
      ctx.lineTo((view.length - 1) * barW, base);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    area((s) => s.solarKw + s.hydroKw, 'rgba(86,217,200,0.4)');
    area((s) => s.solarKw, 'rgba(240,166,58,0.92)');

    // Outline of the total generation.
    ctx.beginPath();
    for (let i = 0; i < view.length; i++) {
      const x = i * barW;
      const y = base - ((view[i].solarKw + view[i].hydroKw) / peak) * h * 0.92;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(180,240,225,0.9)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();

    // Demand line.
    ctx.beginPath();
    for (let i = 0; i < view.length; i++) {
      const x = i * barW;
      const y = base - (view[i].demandKw / peak) * h * 0.92;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(233,238,244,0.72)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scale labels.
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(`${peak.toFixed(0)} kW`, 4 * dpr, 3 * dpr);
    ctx.textBaseline = 'bottom';
    const label = `demand ${view[view.length - 1].demandKw.toFixed(0)} kW`;
    ctx.fillText(label, w - ctx.measureText(label).width - 4 * dpr, h - 3 * dpr);
  }
}
