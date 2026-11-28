/**
 * Passkeys: signing in with a key pair kept by the person's device.
 *
 * The device holds a private key that never leaves it. The server holds the
 * matching public key. To sign in, the server sends a random challenge and
 * the device signs it, after checking the person with a fingerprint, a face
 * or a PIN. There is no secret on the server to steal and nothing the
 * person can be tricked into typing on a fake site: the device refuses to
 * sign for any site but the one the passkey was made for.
 *
 * The standard is called WebAuthn. Checking a signed response is done by a
 * library behind the PasskeyVerifier port; the rules here are the ones that
 * are ours to decide.
 */
export const PASSKEY_RULES = {
  /** The most passkeys one person may register. */
  maxPerUser: 10,
  /** How long a person has to answer a challenge. */
  challengeTtlSeconds: 5 * 60,
  /** The longest name kept for a passkey. */
  nameMaxLength: 60,
} as const;

/** The two things a passkey challenge can be for. */
export const PASSKEY_CEREMONIES = ['registration', 'authentication'] as const;

export type PasskeyCeremony = (typeof PASSKEY_CEREMONIES)[number];

/** A registered passkey, as stored. It holds no secret: the key is the public half. */
export interface Passkey {
  id: string;
  userId: string;
  /** The identifier the device gave the credential, in URL-safe base64. Unique. */
  credentialId: string;
  /** The public key, in the encoding the device sent it (COSE), as URL-safe base64. */
  publicKey: string;
  /**
   * How many times the device says the passkey has been used. Many devices
   * always report 0; for those that count, it must only ever go up.
   */
  signCount: number;
  /** How the device can be reached ("internal", "usb", "nfc", "ble", "hybrid"). A hint only. */
  transports: readonly string[];
  /** True when the passkey can live on several devices, synced by its provider. */
  multiDevice: boolean;
  /** True when the provider reports the passkey is backed up. */
  backedUp: boolean;
  /** The person's own label for it: "My phone". */
  name: string;
  createdAt: string;
  /** ISO 8601 instant of the latest sign-in with it, or null. */
  lastUsedAt: string | null;
}

/** A challenge waiting for its answer. It is used once and then removed. */
export interface PasskeyChallenge {
  id: string;
  ceremony: PasskeyCeremony;
  /**
   * The signed-in user registering a passkey. Null for signing in: the
   * server does not yet know who is asking.
   */
  userId: string | null;
  /** The random value the device must sign, in URL-safe base64. */
  challenge: string;
  createdAt: string;
  expiresAt: string;
}

/** When a challenge made at `now` stops being accepted. */
export const passkeyChallengeExpiry = (now: Date): string =>
  new Date(
    now.getTime() + PASSKEY_RULES.challengeTtlSeconds * 1000,
  ).toISOString();

/**
 * Whether a stored challenge may answer this request: it exists, is for
 * this ceremony and this user, and is not past its time. `now` is an ISO
 * 8601 instant.
 */
export const isPasskeyChallengeUsable = (
  challenge: PasskeyChallenge | null,
  ceremony: PasskeyCeremony,
  userId: string | null,
  now: string,
): challenge is PasskeyChallenge =>
  challenge !== null &&
  challenge.ceremony === ceremony &&
  challenge.userId === userId &&
  challenge.expiresAt > now;

export type SignCountVerdict =
  /** The count is consistent. Store the reported value. */
  | 'ok'
  /**
   * The device reported a count no higher than the one stored. The same
   * private key is in use somewhere else: a copy was made.
   */
  | 'cloned';

/**
 * Judges the use count a device reported against the one stored.
 *
 * A device that does not count reports 0 every time, which is allowed.
 * Once a count has been above 0, every use must raise it.
 */
export const judgeSignCount = (
  stored: number,
  reported: number,
): SignCountVerdict =>
  (stored === 0 && reported === 0) || reported > stored ? 'ok' : 'cloned';

/**
 * Cleans the label a person gives a passkey: no control characters, single
 * spaces, a bounded length. Falls back to `fallback` when nothing usable is
 * left.
 */
export const parsePasskeyName = (input: unknown, fallback: string): string => {
  if (typeof input !== 'string') return fallback;
  const cleaned = input
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return fallback;
  return Array.from(cleaned)
    .slice(0, PASSKEY_RULES.nameMaxLength)
    .join('')
    .trim();
};

/** Whether a value has the shape of URL-safe base64 with no padding. */
export const isBase64Url = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
