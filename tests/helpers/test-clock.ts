/**
 * Controllable clock for deterministic time-window tests (SPEC-007-5-6).
 *
 * All governance functions accept an optional `now` parameter;
 * tests pass `clock.now()` instead of relying on `new Date()`.
 */
export class TestClock {
  private current: Date;

  constructor(initial: string | Date = '2026-04-08T14:30:00Z') {
    this.current = typeof initial === 'string' ? new Date(initial) : initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 24 * 60 * 60 * 1000);
  }

  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 60 * 60 * 1000);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }

  set(date: string | Date): void {
    this.current = typeof date === 'string' ? new Date(date) : date;
  }
}
