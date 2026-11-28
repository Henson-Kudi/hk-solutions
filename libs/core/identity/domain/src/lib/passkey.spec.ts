import {
  PASSKEY_RULES,
  isBase64Url,
  isPasskeyChallengeUsable,
  judgeSignCount,
  parsePasskeyName,
  passkeyChallengeExpiry,
  type PasskeyChallenge,
} from './passkey';
import { SIGN_IN_METHODS } from './session';

const NOW = new Date('2026-11-28T09:00:00.000Z');

const challenge = (
  overrides: Partial<PasskeyChallenge> = {},
): PasskeyChallenge => ({
  id: 'challenge-1',
  ceremony: 'registration',
  userId: 'user-1',
  challenge: 'cmFuZG9tLWNoYWxsZW5nZQ',
  createdAt: NOW.toISOString(),
  expiresAt: passkeyChallengeExpiry(NOW),
  ...overrides,
});

describe('passkey rules', () => {
  it('are the agreed values', () => {
    expect(PASSKEY_RULES).toEqual({
      maxPerUser: 10,
      challengeTtlSeconds: 300,
      nameMaxLength: 60,
    });
  });

  it('gives a challenge five minutes', () => {
    expect(passkeyChallengeExpiry(NOW)).toBe('2026-11-28T09:05:00.000Z');
  });

  it('counts a passkey as a way of signing in', () => {
    expect(SIGN_IN_METHODS).toEqual(['password', 'otp', 'passkey']);
  });
});

describe('isPasskeyChallengeUsable', () => {
  it('accepts a live challenge for the same ceremony and user', () => {
    expect(
      isPasskeyChallengeUsable(
        challenge(),
        'registration',
        'user-1',
        '2026-11-28T09:04:59.999Z',
      ),
    ).toBe(true);
  });

  it('accepts a sign-in challenge, which belongs to no user yet', () => {
    expect(
      isPasskeyChallengeUsable(
        challenge({ ceremony: 'authentication', userId: null }),
        'authentication',
        null,
        NOW.toISOString(),
      ),
    ).toBe(true);
  });

  it.each<
    [
      string,
      PasskeyChallenge | null,
      'registration' | 'authentication',
      string | null,
      string,
    ]
  >([
    ['no challenge', null, 'registration', 'user-1', NOW.toISOString()],
    [
      'one at its expiry instant',
      challenge(),
      'registration',
      'user-1',
      '2026-11-28T09:05:00.000Z',
    ],
    [
      'one for the other ceremony',
      challenge(),
      'authentication',
      'user-1',
      NOW.toISOString(),
    ],
    [
      'one made for another user',
      challenge(),
      'registration',
      'user-2',
      NOW.toISOString(),
    ],
    [
      // A registration challenge must not let an anonymous caller sign in.
      'a registration challenge used with no user',
      challenge(),
      'registration',
      null,
      NOW.toISOString(),
    ],
    [
      'a sign-in challenge claimed by a user',
      challenge({ ceremony: 'authentication', userId: null }),
      'authentication',
      'user-1',
      NOW.toISOString(),
    ],
  ])('refuses %s', (_name, stored, ceremony, userId, now) => {
    expect(isPasskeyChallengeUsable(stored, ceremony, userId, now)).toBe(false);
  });
});

describe('judgeSignCount', () => {
  it.each<[number, number, 'ok' | 'cloned']>([
    // A device that does not count.
    [0, 0, 'ok'],
    // A device that starts counting.
    [0, 1, 'ok'],
    [5, 6, 'ok'],
    [5, 500, 'ok'],
    // The same count again: the response was replayed, or the key copied.
    [5, 5, 'cloned'],
    [5, 4, 'cloned'],
    // A device that counted before cannot go back to "I do not count".
    [5, 0, 'cloned'],
  ])('stored %i, reported %i: %s', (stored, reported, verdict) => {
    expect(judgeSignCount(stored, reported)).toBe(verdict);
  });
});

describe('parsePasskeyName', () => {
  it.each<[unknown, string]>([
    ['My phone', 'My phone'],
    ['  Clé   YubiKey  ', 'Clé YubiKey'],
    ['Laptop\n\u0000work', 'Laptop work'],
    ['Phone‮X', 'Phone X'],
    ['هاتفي', 'هاتفي'],
    ['', 'Passkey'],
    ['   ', 'Passkey'],
    [undefined, 'Passkey'],
    [null, 'Passkey'],
    [7, 'Passkey'],
  ])('%j becomes %j', (input, expected) => {
    expect(parsePasskeyName(input, 'Passkey')).toBe(expected);
  });

  it('keeps at most 60 characters', () => {
    expect(parsePasskeyName('a'.repeat(200), 'Passkey')).toHaveLength(60);
    expect(
      Array.from(parsePasskeyName('😀'.repeat(90), 'Passkey')),
    ).toHaveLength(60);
  });
});

describe('isBase64Url', () => {
  it.each(['abc', 'A-Z_09', 'cmFuZG9t'])('accepts %j', (value) => {
    expect(isBase64Url(value)).toBe(true);
  });

  it.each(['', 'a+b', 'a/b', 'abc=', 'a b', 'é', 12, null, undefined])(
    'refuses %j',
    (value) => {
      expect(isBase64Url(value)).toBe(false);
    },
  );
});
