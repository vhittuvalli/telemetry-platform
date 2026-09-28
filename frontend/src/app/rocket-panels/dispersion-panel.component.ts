import { Component, computed, input, signal } from '@angular/core';
import { Dispersion } from '../replay/replay.models';

const WIDTH = 252;
const HEIGHT = 64;
const BINS = 14;
const GAP = 2;

interface Bin {
  lo: number;
  hi: number;
  count: number;
  x: number;
  width: number;
  height: number;
}

/** Monte Carlo results: apogee spread (with a histogram) and the landing zone's size. */
@Component({
  selector: 'app-dispersion-panel',
  standalone: true,
  templateUrl: './dispersion-panel.component.html',
  styleUrl: './dispersion-panel.component.scss',
})
export class DispersionPanelComponent {
  dispersion = input.required<Dispersion>();
  nominalApogee = input.required<number>();

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected active = signal<Bin | null>(null);

  protected bins = computed<Bin[]>(() => {
    const values = this.dispersion().apogees;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const size = (hi - lo) / BINS || 1;
    const counts = new Array(BINS).fill(0);
    for (const v of values) counts[Math.min(BINS - 1, Math.floor((v - lo) / size))]++;
    const most = Math.max(...counts);
    const slot = WIDTH / BINS;
    const barWidth = Math.min(24, slot - GAP);
    return counts.map((count, i) => ({
      lo: lo + i * size,
      hi: lo + (i + 1) * size,
      count,
      x: i * slot + (slot - barWidth) / 2,
      width: barWidth,
      height: (count / most) * (HEIGHT - 14),
    }));
  });

  /** Where the nominal flight's apogee falls on the histogram. */
  protected nominalX = computed(() => {
    const bins = this.bins();
    const lo = bins[0].lo;
    const hi = bins[bins.length - 1].hi;
    return ((this.nominalApogee() - lo) / (hi - lo)) * WIDTH;
  });

  protected zone95 = computed(() => this.dispersion().landing.zones.find((z) => z.probability >= 0.9)!);

  /** A bar with a 4px rounded top and a square base on the baseline. */
  protected barPath(b: Bin): string {
    const r = Math.min(4, b.width / 2, b.height);
    const x0 = b.x;
    const x1 = b.x + b.width;
    const y0 = HEIGHT;
    const y1 = HEIGHT - b.height;
    return `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x1 - r}Q${x1},${y1} ${x1},${y1 + r}V${y0}Z`;
  }

  protected round(v: number): string {
    return Math.round(v).toLocaleString();
  }
}
