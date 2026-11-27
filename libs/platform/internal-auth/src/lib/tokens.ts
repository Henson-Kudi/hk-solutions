import { AppError } from '@hk/platform/errors';
import {
  createUuidV7Generator,
  isUuid,
  systemClock,
  type Clock,
} from '@hk/platform/universal';
import {
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';
import {
  isScope,
  type Principal,
  type ServiceScopeRegistry,
} from './principal';

/**
 * Internal tokens: who is calling, proven with a signature.
 *
 * - Signed with ES256 only (ECDSA on P-256). Each service has its own key
 *   pair. The private key never leaves the service, and others verify with
 *   the public key.
 * - Short-lived: 60 seconds by default. A stolen token is useless almost at
 *   once, and no revocation list is needed.
 * - Addressed: `aud` names the one service the token is for, so a token sent
 *   to sales cannot be replayed against core.
 *
 * Changes here need Henson's line-by-line review.
 */

export const ALGORITHM = 'ES256';
export const DEFAULT_TTL_SECONDS = 60;

/** A public key, as a JWK with a `kid`. Safe to distribute. */
export type PublicJwk = JWK & { kid: string };

/** A private key, as a JWK with a `kid`. A secret: load it from configuration, never log it. */
export type PrivateJwk = JWK & { kid: string; d: string };

/** Creates a key pair. For tests and for the tooling that provisions a service. */
export const generateEs256KeyPair = async (
  kid: string,
): Promise<{ privateJwk: PrivateJwk; publicJwk: PublicJwk }> => {
  const pair = await generateKeyPair(ALGORITHM, { extractable: true });
  const use = { kid, alg: ALGORITHM, use: 'sig' };
  return {
    privateJwk: { ...(await exportJWK(pair.privateKey)), ...use } as PrivateJwk,
    publicJwk: { ...(await exportJWK(pair.publicKey)), ...use } as PublicJwk,
  };
};

/**
 * Why a token was refused. For logs and tests. The caller is only ever told
 * "401": telling an attacker which check failed helps them pass it.
 */
export type TokenRejection =
  | 'missing'
  | 'malformed'
  /** Not ES256. This is what stops an HS256 or "none" token. */
  | 'algorithm'
  | 'unknown-issuer'
  | 'unknown-key'
  | 'signature'
  | 'audience'
  | 'expired'
  | 'not-yet-valid'
  /** Valid for longer than a token may be. */
  | 'lifetime'
  | 'claims'
  /** A user token from a service that may not mint them. */
  | 'issuer-not-allowed'
  /** A scope the calling service's manifest does not declare. */
  | 'scope';

export class TokenError extends AppError {
  readonly reason: TokenRejection;

  constructor(reason: TokenRejection, cause?: unknown) {
    super('UNAUTHENTICATED', 401, 'Authentication is required.', {
      headers: { 'WWW-Authenticate': 'Bearer' },
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'TokenError';
    this.reason = reason;
  }
}

export interface UserTokenInput {
  /** The service the token is for. */
  audience: string;
  userId: string;
  tenantId: string;
  businessId: string;
  branchId?: string;
  permissions: readonly string[];
}

export interface ServiceTokenInput {
  /** The service being called. */
  audience: string;
  scopes: readonly string[];
}

export interface TokenSignerOptions {
  /** This service's name. Becomes `iss`. */
  issuer: string;
  privateJwk: PrivateJwk;
  clock?: Clock;
  /** Defaults to 60. */
  ttlSeconds?: number;
}

export interface TokenSigner {
  /** A token that says "this user, in this business, with these permissions". Only the gateway mints these. */
  userToken(input: UserTokenInput): Promise<string>;
  /** A token that says "this service is calling, to do these things". */
  serviceToken(input: ServiceTokenInput): Promise<string>;
}

const nextId = createUuidV7Generator();

export const createTokenSigner = (options: TokenSignerOptions): TokenSigner => {
  const { issuer, privateJwk } = options;
  const clock = options.clock ?? systemClock;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (
    privateJwk.kty !== 'EC' ||
    privateJwk.crv !== 'P-256' ||
    !privateJwk.d ||
    !privateJwk.kid
  ) {
    // The key is not included: it is a secret.
    throw new Error('The signing key must be a P-256 private JWK with a kid.');
  }
  const key = importJWK(privateJwk, ALGORITHM);

  const sign = async (
    audience: string,
    subject: string,
    claims: JWTPayload,
  ): Promise<string> => {
    const issuedAt = Math.floor(clock.now().getTime() / 1_000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALGORITHM, kid: privateJwk.kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .setJti(nextId())
      .sign(await key);
  };

  return {
    userToken: (input) =>
      sign(input.audience, input.userId, {
        token_use: 'user',
        tid: input.tenantId,
        bid: input.businessId,
        ...(input.branchId === undefined ? {} : { brid: input.branchId }),
        perms: [...input.permissions],
      }),
    serviceToken: (input) =>
      sign(input.audience, issuer, {
        token_use: 'service',
        scopes: [...input.scopes],
      }),
  };
};

export interface TokenVerifierOptions {
  /** This service's name. A token must be addressed to it. */
  audience: string;
  /**
   * The public keys of every service whose tokens this one accepts, by
   * service name. A token is checked against the keys of the issuer it
   * claims, and no others: the sales key cannot sign as the gateway.
   */
  trustedIssuers: Readonly<Record<string, readonly PublicJwk[]>>;
  /** Services allowed to mint user tokens. Defaults to ["gateway"]. */
  userTokenIssuers?: readonly string[];
  /** Which scopes each service may claim. Without it, a service token with any scope is refused. */
  scopes?: ServiceScopeRegistry;
  clock?: Clock;
  /** Allowed difference between this machine's clock and the issuer's. Defaults to 5. */
  clockToleranceSeconds?: number;
  /** Longest `exp - iat` accepted. Defaults to 300. */
  maxLifetimeSeconds?: number;
}

export interface TokenVerifier {
  /** Resolves with the principal, or rejects with a TokenError. Never returns a partly trusted result. */
  verify(token: string | undefined): Promise<Principal>;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const createTokenVerifier = (
  options: TokenVerifierOptions,
): TokenVerifier => {
  const clock = options.clock ?? systemClock;
  const tolerance = options.clockToleranceSeconds ?? 5;
  const maxLifetime = options.maxLifetimeSeconds ?? 300;
  const userTokenIssuers = options.userTokenIssuers ?? ['gateway'];

  // Import each key once. Keyed by issuer, then kid.
  const keys = new Map<string, Map<string, ReturnType<typeof importJWK>>>();
  for (const [issuer, jwks] of Object.entries(options.trustedIssuers)) {
    const byKid = new Map<string, ReturnType<typeof importJWK>>();
    for (const jwk of jwks) {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid || 'd' in jwk) {
        throw new Error(
          `Trusted key for "${issuer}" must be a P-256 public JWK with a kid.`,
        );
      }
      byKid.set(jwk.kid, importJWK(jwk, ALGORITHM));
    }
    keys.set(issuer, byKid);
  }

  const verify = async (token: string | undefined): Promise<Principal> => {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TokenError('missing');
    }

    // Steps 1 to 3 read the token before its signature is checked, only to
    // find out which key to check it with. Nothing read here is trusted.
    let header: ReturnType<typeof decodeProtectedHeader>;
    let unverified: JWTPayload;
    try {
      header = decodeProtectedHeader(token);
      unverified = decodeJwt(token);
    } catch (cause) {
      throw new TokenError('malformed', cause);
    }

    // 1. The algorithm is fixed. A token that names any other, including
    //    HS256 and "none", is refused before a key is even looked up.
    if (header.alg !== ALGORITHM) {
      throw new TokenError('algorithm');
    }
    if (typeof header.kid !== 'string' || typeof unverified.iss !== 'string') {
      throw new TokenError('malformed');
    }

    // 2. The key comes from the issuer the token claims.
    const issuerKeys = keys.get(unverified.iss);
    if (!issuerKeys) {
      throw new TokenError('unknown-issuer');
    }
    const key = issuerKeys.get(header.kid);
    if (!key) {
      throw new TokenError('unknown-key');
    }

    // 3. Signature, audience, expiry and required claims.
    const now = clock.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await key, {
        algorithms: [ALGORITHM],
        issuer: unverified.iss,
        audience: options.audience,
        currentDate: now,
        clockTolerance: tolerance,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
      }));
    } catch (cause) {
      if (cause instanceof joseErrors.JWTExpired) {
        throw new TokenError('expired', cause);
      }
      if (cause instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new TokenError('signature', cause);
      }
      if (cause instanceof joseErrors.JOSEAlgNotAllowed) {
        throw new TokenError('algorithm', cause);
      }
      if (cause instanceof joseErrors.JWTClaimValidationFailed) {
        throw new TokenError(
          cause.claim === 'aud'
            ? 'audience'
            : cause.claim === 'nbf'
              ? 'not-yet-valid'
              : 'claims',
          cause,
        );
      }
      throw new TokenError('malformed', cause);
    }

    // 4. Time: not from the future, and not valid for longer than allowed.
    const issuedAt = payload.iat as number;
    const expiresAt = payload.exp as number;
    if (issuedAt > Math.floor(now.getTime() / 1_000) + tolerance) {
      throw new TokenError('not-yet-valid');
    }
    if (expiresAt - issuedAt > maxLifetime) {
      throw new TokenError('lifetime');
    }

    const issuer = payload.iss as string;
    const subject = payload.sub as string;
    const tokenId = payload.jti as string;

    // 5. What the token says, by kind.
    if (payload['token_use'] === 'user') {
      if (!userTokenIssuers.includes(issuer)) {
        throw new TokenError('issuer-not-allowed');
      }
      const tenantId = payload['tid'];
      const businessId = payload['bid'];
      const branchId = payload['brid'];
      const permissions = payload['perms'];
      if (
        !isUuid(subject) ||
        !isUuid(tenantId) ||
        !isUuid(businessId) ||
        (branchId !== undefined && !isUuid(branchId)) ||
        !isStringArray(permissions)
      ) {
        throw new TokenError('claims');
      }
      return Object.freeze({
        kind: 'user',
        userId: subject,
        tenantId,
        businessId,
        ...(branchId === undefined ? {} : { branchId }),
        permissions: Object.freeze([...permissions]),
        issuer,
        tokenId,
      });
    }

    if (payload['token_use'] === 'service') {
      const scopes = payload['scopes'];
      // A service signs for itself only.
      if (subject !== issuer || !isStringArray(scopes)) {
        throw new TokenError('claims');
      }
      for (const scope of scopes) {
        if (!isScope(scope) || !options.scopes?.declares(issuer, scope)) {
          throw new TokenError('scope');
        }
      }
      return Object.freeze({
        kind: 'service',
        service: issuer,
        scopes: Object.freeze([...scopes]),
        tokenId,
      });
    }

    throw new TokenError('claims');
  };

  return { verify };
};

/**
 * For @hk/platform/http: a `headers` function that puts a fresh service token
 * on every call to one service.
 *
 *   createHttpClient({
 *     baseUrl: config.CORE_URL,
 *     name: 'core-api',
 *     headers: serviceTokenHeaders(signer, {
 *       audience: 'core',
 *       scopes: ['contacts:read'],
 *     }),
 *   });
 */
export const serviceTokenHeaders =
  (signer: TokenSigner, input: ServiceTokenInput) =>
  async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await signer.serviceToken(input)}`,
  });
