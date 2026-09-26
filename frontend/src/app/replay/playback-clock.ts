export class PlaybackClock {
  time: number;
  playing = false;
  speed = 1;

  constructor(public readonly start: number, public readonly end: number) {
    this.time = start;
  }

  /** Advance by real elapsed seconds, scaled by playback speed. */
  tick(dt: number): void {
    if (!this.playing) return;
    this.time = Math.min(this.end, this.time + dt * this.speed);
    if (this.time >= this.end) this.playing = false;
  }

  //track time
  seek(t: number): void {
    this.time = Math.max(this.start, Math.min(this.end, t));
  }

  //track whether its playing or not
  toggle(): void {
    this.playing = !this.playing;
  }
}