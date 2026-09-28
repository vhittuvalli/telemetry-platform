import { Component, computed, input, output } from '@angular/core';
import { ChartSeries } from '../rocket/rocket-scene';

const WIDTH = 340;
const HEIGHT = 76;
const PAD = { left: 44, right: 10, top: 6, bottom: 6 };

/** Round tick values covering [lo, hi]: steps of 1, 2 or 5 × 10ⁿ. */
function ticks(lo: number, hi: number, count = 3): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const step = (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Linear interpolation of a series at time t. */
export function valueAt(series: ChartSeries, t: number): number {
  const { time, values } = series;
  if (t <= time[0]) return values[0];
  if (t >= time[time.length - 1]) return values[values.length - 1];
  let lo = 0;
  let hi = time.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - time[lo]) / (time[hi] - time[lo] || 1);
  return values[lo] + (values[hi] - values[lo]) * f;
}

/** One channel over the flight: a single line, a playhead at the current time, and a hover crosshair. */
@Component({
  selector: 'app-flight-chart',
  standalone: true,
  templateUrl: './flight-chart.component.html',
  styleUrl: './flight-chart.component.scss',
})
export class FlightChartComponent {
  title = input.required<string>();
  unit = input.required<string>();
  series = input.required<ChartSeries>();
  range = input.required<{ start: number; end: number }>();
  time = input.required<number>();
  hoverTime = input<number | null>(null);
  hover = output<number | null>();
  seek = output<number>();

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly left = PAD.left;
  protected readonly right = WIDTH - PAD.right;

  private yDomain = computed(() => {
    const v = this.series().values;
    let lo = Math.min(0, ...v);
    let hi = Math.max(...v);
    if (hi - lo < 1e-9) hi = lo + 1;
    const pad = (hi - lo) * 0.06;
    return [lo < 0 ? lo - pad : lo, hi + pad] as const;
  });

  protected x = (t: number) => {
    const { start, end } = this.range();
    return PAD.left + ((t - start) / (end - start || 1)) * (WIDTH - PAD.left - PAD.right);
  };

  protected y = (v: number) => {
    const [lo, hi] = this.yDomain();
    return HEIGHT - PAD.bottom - ((v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);
  };

  protected path = computed(() => {
    const { time, values } = this.series();
    return time.map((t, i) => `${i ? 'L' : 'M'}${this.x(t).toFixed(1)},${this.y(values[i]).toFixed(1)}`).join('');
  });

  protected yTicks = computed(() => {
    const [lo, hi] = this.yDomain();
    return ticks(lo, hi);
  });

  protected current = computed(() => valueAt(this.series(), this.time()));

  protected hovered = computed(() => {
    const t = this.hoverTime();
    return t == null ? null : { x: this.x(t), y: this.y(valueAt(this.series(), t)) };
  });

  protected format(v: number): string {
    const abs = Math.abs(v);
    return abs >= 1000 ? Math.round(v).toLocaleString() : abs >= 10 ? v.toFixed(0) : v.toFixed(1);
  }

  /** The time under the pointer, snapped to the plot. */
  private timeAt(event: MouseEvent): number {
    const svg = event.currentTarget as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * WIDTH;
    const { start, end } = this.range();
    const f = (px - PAD.left) / (WIDTH - PAD.left - PAD.right);
    return start + Math.min(Math.max(f, 0), 1) * (end - start);
  }

  protected onMove(event: PointerEvent): void {
    this.hover.emit(this.timeAt(event));
  }

  protected onLeave(): void {
    this.hover.emit(null);
  }

  protected onClick(event: MouseEvent): void {
    this.seek.emit(this.timeAt(event));
  }
}
