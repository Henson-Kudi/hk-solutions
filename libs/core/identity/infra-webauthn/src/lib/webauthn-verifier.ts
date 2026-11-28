import type {
  PasskeyOptions,
  PasskeyVerifier,
} from '@hk/core/identity/application';
import { PASSKEY_RULES, isBase64Url } from '@hk/core/identity/domain';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * The real WebAuthn verifier: the PasskeyVerifier port, implemented with
 * the @simplewebauthn/server library.
 *
 * The parsing of what a device sends, and the checking of its signature,
 * are the library's. What is decided here is what we ask of a device and
 * what we insist on:
 *
 * - The passkey must be discoverable, so a person can sign in without
 *   typing who they are first.
 * - The device must verify the person (fingerprint, face or PIN) every
 *   time. A passkey is the only factor at sign-in, so "someone touched the
 *   device" is not enough.
 * - No attestation is asked for. Attestation says which make of device
 *   holds the key; we have no rule that depends on it, and asking for it
 *   costs the person an extra consent screen.
 * - A response is accepted only from the origins configured here.
 */
export interface WebAuthnVerifierOptions {
  /**
   * The site passkeys belong to: a domain name with no scheme or port,
   * such as "hk.example". A passkey made for it works on that domain and
   * its subdomains, and nowhere else. It cannot be changed later without
   * every passkey having to be registered again.
   */
  rpId: string;
  /** The name a device shows for the site. */
  rpName: string;
  /**
   * Every origin a response may come from: "https://app.hk.example" for a
   * web page, "android:apk-key-hash:..." for an Android app.
   */
  origins: readonly string[];
}

/**
 * The signature algorithms accepted: EdDSA, ES256 and RS256, by their COSE
 * numbers. Between them they cover the devices in use. The list is fixed
 * here so that a library upgrade cannot widen it unnoticed.
 */
export const WEBAUTHN_ALGORITHMS = [-8, -7, -257] as const;

const isLocalhost = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost');

/** Throws when the configuration could not work or would be unsafe. */
const checkOptions = (options: WebAuthnVerifierOptions): void => {
  const { rpId, rpName, origins } = options;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(rpId)) {
    throw new Error(
      'WebAuthn rpId must be a lower-case domain name with no scheme or port.',
    );
  }
  if (rpName.trim() === '') {
    throw new Error('WebAuthn rpName must not be empty.');
  }
  if (origins.length === 0) {
    throw new Error('WebAuthn needs at least one origin.');
  }
  for (const origin of origins) {
    // An Android app identifies itself by the hash of its signing key.
    if (/^android:apk-key-hash:[A-Za-z0-9_-]{20,}$/.test(origin)) continue;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('A WebAuthn origin is not a valid URL.');
    }
    if (url.origin !== origin) {
      throw new Error(
        'A WebAuthn origin must be a bare origin: scheme and host, no path.',
      );
    }
    const local = isLocalhost(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('A WebAuthn origin must use https.');
    }
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      throw new Error(
        'A WebAuthn origin must be the rpId or one of its subdomains.',
      );
    }
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createWebAuthnVerifier = (
  options: WebAuthnVerifierOptions,
): PasskeyVerifier => {
  checkOptions(options);
  const { rpId, rpName } = options;
  const origins = [...options.origins];
  const timeout = PASSKEY_RULES.challengeTtlSeconds * 1000;

  const asOptions = (made: { challenge: string }): PasskeyOptions => ({
    challenge: made.challenge,
    options: made as unknown as Readonly<Record<string, unknown>>,
  });

  return {
    registrationOptions: async (input) =>
      asOptions(
        await generateRegistrationOptions({
          rpName,
          rpID: rpId,
          // The user handle: the user's id as bytes. It holds no personal
          // data, as the standard asks.
          userID: new TextEncoder().encode(input.userId),
          userName: input.userName,
          userDisplayName: input.displayName,
          timeout,
          attestationType: 'none',
          excludeCredentials: input.exclude.map((item) => ({
            id: item.credentialId,
            transports: [...item.transports],
          })),
          authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
          },
          supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
        }),
      ),

    verifyRegistration: async ({ response, challenge }) => {
      if (!isObject(response)) return null;
      try {
        const result = await verifyRegistrationResponse({
          response: response as unknown as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
          requireUserVerification: true,
          supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
        });
        if (!result.verified) return null;
        const info = result.registrationInfo;
        return {
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString(
            'base64url',
          ),
          signCount: info.credential.counter,
          transports: [...(info.credential.transports ?? [])],
          multiDevice: info.credentialDeviceType === 'multiDevice',
          backedUp: info.credentialBackedUp,
        };
      } catch {
        // The library throws for a response that does not check out. Which
        // check failed is deliberately not passed on.
        return null;
      }
    },

    authenticationOptions: async () =>
      asOptions(
        await generateAuthenticationOptions({
          rpID: rpId,
          timeout,
          userVerification: 'required',
          // No allowCredentials: the device offers the person the passkeys
          // it holds for this site.
        }),
      ),

    credentialIdOf: (response) =>
      isObject(response) &&
      isBase64Url(response['id']) &&
      response['id'].length <= 1400
        ? response['id']
        : null,

    verifyAuthentication: async ({ response, challenge, credential }) => {
      if (!isObject(response)) return null;
      try {
        const result = await verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: origins,
          expectedRPID: rpId,
          credential: {
            id: credential.credentialId,
            publicKey: Buffer.from(credential.publicKey, 'base64url'),
            counter: credential.signCount,
            transports: [...credential.transports],
          },
          requireUserVerification: true,
        });
        if (!result.verified) return null;
        if (
          result.authenticationInfo.credentialID !== credential.credentialId
        ) {
          return null;
        }
        const inner = isObject(response['response'])
          ? response['response']
          : {};
        const handle = inner['userHandle'];
        return {
          signCount: result.authenticationInfo.newCounter,
          backedUp: result.authenticationInfo.credentialBackedUp,
          userId: isBase64Url(handle)
            ? Buffer.from(handle, 'base64url').toString('utf8')
            : null,
        };
      } catch {
        return null;
      }
    },
  };
};
