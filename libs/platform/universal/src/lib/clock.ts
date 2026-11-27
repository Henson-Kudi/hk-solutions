import { DomainError } from './domain-error';

/**
 * The only way pure code learns the time. Use cases take a Clock as a port, so
 * tests can fix the time and offline devices can supply their own.
 */
export interface Clock {
  /** A new Date on every call, so a caller cannot change the clock by mutating it. */
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

const toTime = (instant: Date | string): number => {
  const time = (
    typeof instant === 'string' ? new Date(instant) : instant
  ).getTime();
  if (Number.isNaN(time)) {
    throw new DomainError(
      'CLOCK_INVALID_INSTANT',
      'Instant is not a valid date. Use an ISO 8601 string such as 2026-01-31T09:00:00Z.',
      { kind: 'invariant' },
    );
  }
  return time;
};

/** A clock that only moves when told to. For tests. */
export class FixedClock implements Clock {
  private time: number;

  constructor(start: Date | string) {
    this.time = toTime(start);
  }

  now(): Date {
    return new Date(this.time);
  }

  set(instant: Date | string): void {
    this.time = toTime(instant);
  }

  /** Move forward (or back, with a negative value) by milliseconds. */
  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}
