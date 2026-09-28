import { DecimalPipe } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { RocketScene } from '../rocket/rocket-scene';
import { FlightChartComponent, valueAt } from './flight-chart.component';

const G = 9.80665;

/** Flight dashboard (live values, phase, events, summary) and time-synced charts for a rocket flight. */
@Component({
  selector: 'app-rocket-panels',
  standalone: true,
  imports: [FlightChartComponent, DecimalPipe],
  templateUrl: './rocket-panels.component.html',
  styleUrl: './rocket-panels.component.scss',
})
export class RocketPanelsComponent {
  scene = input.required<RocketScene>();
  seek = output<number>();

  protected hoverTime = signal<number | null>(null);
  protected meta = computed(() => this.scene().meta);
  protected state = computed(() => this.scene().state());
  protected time = computed(() => this.scene().time());
  protected range = computed(() => this.meta().time_range);

  protected tiles = computed(() => {
    const s = this.state();
    if (!s) return [];
    return [
      { label: 'Vertical speed', value: s.vertical_velocity.toFixed(0), unit: 'm/s' },
      { label: 'Speed', value: (s.speed / 3.6).toFixed(0), unit: 'm/s' },
      { label: 'Acceleration', value: (s.acceleration / G).toFixed(1), unit: 'g' },
      { label: 'Mach', value: s.mach.toFixed(2), unit: '' },
      { label: 'Dynamic pressure', value: (s.dynamic_pressure / 1000).toFixed(1), unit: 'kPa' },
      { label: 'Stability', value: s.stability_margin.toFixed(1), unit: 'cal' },
    ];
  });

  protected summary = computed(() => {
    const m = this.meta();
    const s = m.summary;
    const [lx, ly] = s.landing;
    return [
      { label: 'Apogee', value: `${Math.round(s.apogee).toLocaleString()} m`, at: s.apogee_time },
      { label: 'Max speed', value: `${s.max_speed.toFixed(0)} m/s · Mach ${s.max_mach.toFixed(2)}`, at: null },
      { label: 'Max Q', value: `${(s.max_q / 1000).toFixed(1)} kPa`, at: s.max_q_time },
      { label: 'Max acceleration', value: `${(s.max_acceleration / G).toFixed(1)} g`, at: null },
      { label: 'Rail exit speed', value: `${s.rail_exit_speed.toFixed(1)} m/s`, at: null },
      { label: 'Landed', value: `${Math.round(Math.hypot(lx, ly)).toLocaleString()} m from the pad`, at: s.flight_time },
    ];
  });

  /** Values at the hovered time, for the shared tooltip. */
  protected hovered = computed(() => {
    const t = this.hoverTime();
    const charts = this.scene().charts();
    if (t == null || !charts) return null;
    return {
      time: t,
      rows: [
        { label: 'Altitude', value: `${Math.round(valueAt(charts.altitude, t)).toLocaleString()} m` },
        { label: 'Vertical speed', value: `${valueAt(charts.velocity, t).toFixed(1)} m/s` },
        { label: 'Acceleration', value: `${valueAt(charts.acceleration, t).toFixed(1)} m/s²` },
      ],
    };
  });

  protected formatTime(t: number): string {
    return `T+${t.toFixed(t < 10 ? 2 : 1)} s`;
  }
}
