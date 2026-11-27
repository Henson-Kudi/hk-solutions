import { FixedClock, systemClock } from './clock';
import { DomainError, isDomainError } from './domain-error';
import {
  isLocale,
  isRtl,
  localize,
  localizedText,
  parseLocalizedText,
} from './localized-text';
import {
  andThen,
  combine,
  err,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from './result';

describe('DomainError', () => {
  it('carries a stable code, a kind and details', () => {
    const error = new DomainError(
      'INVOICE_ALREADY_ISSUED',
      'Invoice is issued.',
      {
        kind: 'conflict',
        details: { status: 'ISSUED' },
      },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('INVOICE_ALREADY_ISSUED');
    expect(error.kind).toBe('conflict');
    expect(error.message).toBe('Invoice is issued.');
    expect(error.details).toEqual({ status: 'ISSUED' });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(isDomainError(error)).toBe(true);
    expect(isDomainError(new Error('x'))).toBe(false);
  });

  it('defaults to a validation error with no details', () => {
    const error = new DomainError('NAME_REQUIRED', 'Name is required.');
    expect(error.kind).toBe('validation');
    expect(error.details).toEqual({});
    expect(error.cause).toBeUndefined();
  });

  it('keeps the cause but does not serialise it', () => {
    const cause = new Error('driver failed');
    const error = new DomainError('SAVE_FAILED', 'Could not save.', {
      kind: 'invariant',
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'SAVE_FAILED',
      kind: 'invariant',
      message: 'Could not save.',
      details: {},
    });
  });
});

describe('Result', () => {
  const failure = new DomainError('NOPE', 'No.');
  const good = ok(2) as Result<number>;
  const bad = err(failure) as Result<number>;

  it('tells success from failure', () => {
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
  });

  it('maps the value and leaves a failure alone', () => {
    expect(mapResult(good, (value) => value * 2)).toEqual(ok(4));
    expect(mapResult(bad, (value) => value * 2)).toBe(bad);
  });

  it('maps the error and leaves a success alone', () => {
    expect(mapError(bad, (error) => error.code)).toEqual(err('NOPE'));
    expect(mapError(good, (error) => error.code)).toBe(good);
  });

  it('chains steps and stops at the first failure', () => {
    const half = (value: number): Result<number> =>
      value % 2 === 0 ? ok(value / 2) : err(failure);
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(andThen(ok(2), half), half)).toEqual(err(failure));
    let called = false;
    andThen(bad, (value) => {
      called = true;
      return ok(value);
    });
    expect(called).toBe(false);
  });

  it('unwraps a value, or throws the original error', () => {
    expect(unwrap(good)).toBe(2);
    expect(() => unwrap(bad)).toThrow(failure);
    expect(unwrapOr(bad, 7)).toBe(7);
    expect(unwrapOr(good, 7)).toBe(2);
  });

  it('wraps a non-Error failure when unwrapping', () => {
    try {
      unwrap(err('plain string'));
      throw new Error('unwrap did not throw');
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('RESULT_UNWRAP_FAILED');
      expect(isDomainError(error) && error.cause).toBe('plain string');
    }
  });

  it('combines a list into all values or the first failure', () => {
    expect(combine([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(combine([])).toEqual(ok([]));
    const second = new DomainError('SECOND', 'Second.');
    expect(combine([ok(1), err(failure), err(second)])).toEqual(err(failure));
  });
});

describe('Clock', () => {
  it('reads the system time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('stays fixed until moved', () => {
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-11-27T10:00:00.000Z');
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-11-27T10:01:30.000Z');
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('cannot be changed by mutating a returned Date', () => {
    const clock = new FixedClock('2026-11-27T10:00:00.000Z');
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-11-27T10:00:00.000Z');
  });

  it('refuses an invalid instant', () => {
    expect(() => new FixedClock('not a date')).toThrow(DomainError);
    const clock = new FixedClock(new Date(0));
    expect(() => clock.set(new Date(Number.NaN))).toThrow(DomainError);
  });
});

describe('LocalizedText', () => {
  it('requires English and French', () => {
    expect(localizedText('Cash', 'Caisse')).toEqual({
      en: 'Cash',
      fr: 'Caisse',
    });
    for (const input of [
      { en: 'Cash' },
      { fr: 'Caisse' },
      { en: 'Cash', fr: '' },
      { en: '   ', fr: 'Caisse' },
      { en: 'Cash', fr: 42 },
      { en: 'Cash', fr: 'Caisse', ar: '' },
      null,
      'Cash',
    ]) {
      const result = parseLocalizedText(input);
      expect(!result.ok && result.error.code).toBe('LOCALIZED_TEXT_INVALID');
    }
    expect(() => localizedText('Cash', '')).toThrow(DomainError);
  });

  it('trims text and drops unknown languages', () => {
    const result = parseLocalizedText({
      en: ' Cash ',
      fr: 'Caisse\n',
      ar: ' نقد ',
      de: 'Kasse',
    });
    expect(result.ok && result.value).toEqual({
      en: 'Cash',
      fr: 'Caisse',
      ar: 'نقد',
    });
  });

  it('picks the requested language and falls back to English', () => {
    const withArabic = localizedText('Cash', 'Caisse', 'نقد');
    const withoutArabic = localizedText('Cash', 'Caisse');
    expect(localize(withArabic, 'fr')).toBe('Caisse');
    expect(localize(withArabic, 'ar')).toBe('نقد');
    expect(localize(withoutArabic, 'ar')).toBe('Cash');
  });

  it('knows the supported locales and which are right to left', () => {
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });
});
