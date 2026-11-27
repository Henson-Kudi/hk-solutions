import { createHmac } from 'node:crypto';
import { FixedClock, createUuidV7Generator } from '@hk/platform/universal';
import { SignJWT, exportSPKI, importJWK } from 'jose';
import { createServiceScopeRegistry, isScope } from './principal';
import {
  TokenError,
  createTokenSigner,
  createTokenVerifier,
  generateEs256KeyPair,
  serviceTokenHeaders,
  type PrivateJwk,
  type PublicJwk,
  type TokenRejection,
  type TokenVerifierOptions,
} from './tokens';

const nextId = createUuidV7Generator();

const USER = nextId();
const TENANT = nextId();
const BUSINESS = nextId();
const BRANCH = nextId();
const NOW = '2026-11-27T10:00:00.000Z';

interface Keys {
  privateJwk: PrivateJwk;
  publicJwk: PublicJwk;
}

/** The reason a token was refused, or what happened instead. */
const rejection = async (
  action: Promise<unknown>,
): Promise<TokenRejection | string> => {
  try {
    await action;
  } catch (error) {
    return error instanceof TokenError
      ? error.reason
      : `NOT_A_TOKEN_ERROR: ${String(error)}`;
  }
  return 'ACCEPTED';
};

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

describe('internal tokens', () => {
  let gateway: Keys;
  let sales: Keys;
  let inventory: Keys;
  let clock: FixedClock;

  const scopes = createServiceScopeRegistry({
    sales: ['contacts:read', 'ledger.postings:request'],
    inventory: ['items:read'],
  });

  /** A verifier for the "core" service. */
  const verifier = (overrides: Partial<TokenVerifierOptions> = {}) =>
    createTokenVerifier({
      audience: 'core',
      trustedIssuers: {
        gateway: [gateway.publicJwk],
        sales: [sales.publicJwk],
        inventory: [inventory.publicJwk],
      },
      scopes,
      clock,
      ...overrides,
    });

  const signer = (issuer: string, keys: Keys, ttlSeconds?: number) =>
    createTokenSigner({
      issuer,
      privateJwk: keys.privateJwk,
      clock,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    });

  const userToken = (audience = 'core') =>
    signer('gateway', gateway).userToken({
      audience,
      userId: USER,
      tenantId: TENANT,
      businessId: BUSINESS,
      branchId: BRANCH,
      permissions: ['invoices:view', 'invoices:issue'],
    });

  const serviceToken = (requested = ['contacts:read'], audience = 'core') =>
    signer('sales', sales).serviceToken({ audience, scopes: requested });

  /** Signs arbitrary claims, to build tokens the real signer never would. */
  const forge = async (
    keys: Keys,
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> => {
    const issuedAt = Math.floor(clock.now().getTime() / 1_000);
    return new SignJWT({
      iss: 'gateway',
      aud: 'core',
      sub: USER,
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: nextId(),
      token_use: 'user',
      tid: TENANT,
      bid: BUSINESS,
      perms: [],
      ...claims,
    })
      .setProtectedHeader({
        alg: 'ES256',
        kid: keys.privateJwk.kid,
        typ: 'JWT',
        ...header,
      })
      .sign(await importJWK(keys.privateJwk, 'ES256'));
  };

  beforeAll(async () => {
    gateway = await generateEs256KeyPair('gateway-2026-11');
    sales = await generateEs256KeyPair('sales-2026-11');
    inventory = await generateEs256KeyPair('inventory-2026-11');
  });

  beforeEach(() => {
    clock = new FixedClock(NOW);
  });

  describe('accepted tokens', () => {
    it('verifies a user token into a user principal', async () => {
      const principal = await verifier().verify(await userToken());
      expect(principal).toEqual({
        kind: 'user',
        userId: USER,
        tenantId: TENANT,
        businessId: BUSINESS,
        branchId: BRANCH,
        permissions: ['invoices:view', 'invoices:issue'],
        issuer: 'gateway',
        tokenId: expect.any(String),
      });
      expect(Object.isFrozen(principal)).toBe(true);
    });

    it('verifies a service token into a service principal', async () => {
      const principal = await verifier().verify(
        await serviceToken(['contacts:read', 'ledger.postings:request']),
      );
      expect(principal).toEqual({
        kind: 'service',
        service: 'sales',
        scopes: ['contacts:read', 'ledger.postings:request'],
        tokenId: expect.any(String),
      });
    });

    it('accepts a user token without a branch, and a service token without scopes', async () => {
      const noBranch = await signer('gateway', gateway).userToken({
        audience: 'core',
        userId: USER,
        tenantId: TENANT,
        businessId: BUSINESS,
        permissions: [],
      });
      expect(await verifier().verify(noBranch)).not.toHaveProperty('branchId');
      expect(await verifier().verify(await serviceToken([]))).toMatchObject({
        scopes: [],
      });
    });

    it('gives every token its own id', async () => {
      const first = await verifier().verify(await userToken());
      const second = await verifier().verify(await userToken());
      expect(first.tokenId).not.toBe(second.tokenId);
    });

    it('is valid for 60 seconds by default', async () => {
      const token = await userToken();
      clock.advance(59_000);
      expect(await rejection(verifier().verify(token))).toBe('ACCEPTED');
    });

    it("accepts any of an issuer's keys, so a key can be rotated", async () => {
      const next = await generateEs256KeyPair('gateway-2026-12');
      const rotating = verifier({
        trustedIssuers: { gateway: [gateway.publicJwk, next.publicJwk] },
      });
      const oldToken = await userToken();
      const newToken = await createTokenSigner({
        issuer: 'gateway',
        privateJwk: next.privateJwk,
        clock,
      }).userToken({
        audience: 'core',
        userId: USER,
        tenantId: TENANT,
        businessId: BUSINESS,
        permissions: [],
      });
      expect(await rejection(rotating.verify(oldToken))).toBe('ACCEPTED');
      expect(await rejection(rotating.verify(newToken))).toBe('ACCEPTED');
    });
  });

  describe('refused: no token', () => {
    it.each([undefined, ''])('refuses %p', async (token) => {
      expect(await rejection(verifier().verify(token))).toBe('missing');
    });

    it.each(['not-a-jwt', 'a.b', 'a.b.c', '....', 'eyJhbGciOiJFUzI1NiJ9.e30'])(
      'refuses the malformed token %p',
      async (token) => {
        expect(await rejection(verifier().verify(token))).toBe('malformed');
      },
    );
  });

  describe('refused: wrong aud', () => {
    it('refuses a token addressed to another service', async () => {
      expect(await rejection(verifier().verify(await userToken('sales')))).toBe(
        'audience',
      );
      expect(
        await rejection(
          verifier().verify(await serviceToken(['contacts:read'], 'inventory')),
        ),
      ).toBe('audience');
    });

    it('refuses a token with no audience', async () => {
      const token = await forge(gateway, { aud: undefined });
      expect(await rejection(verifier().verify(token))).toBe('audience');
    });
  });

  describe('refused: expired', () => {
    it('refuses a token past its expiry and the clock tolerance', async () => {
      const token = await userToken();
      clock.advance(60_000 + 5_000);
      expect(await rejection(verifier().verify(token))).toBe('expired');
    });

    it('tolerates a few seconds of clock difference, and no more', async () => {
      const token = await userToken();
      clock.advance(60_000 + 4_000);
      expect(await rejection(verifier().verify(token))).toBe('ACCEPTED');
    });

    it('refuses a token issued in the future', async () => {
      const token = await userToken();
      clock.advance(-30_000);
      expect(await rejection(verifier().verify(token))).toBe('not-yet-valid');
    });

    it('refuses a token that is valid for too long', async () => {
      const longLived = await signer('gateway', gateway, 3_600).userToken({
        audience: 'core',
        userId: USER,
        tenantId: TENANT,
        businessId: BUSINESS,
        permissions: [],
      });
      expect(await rejection(verifier().verify(longLived))).toBe('lifetime');
    });

    it('refuses a token with no expiry', async () => {
      const token = await forge(gateway, { exp: undefined });
      expect(await rejection(verifier().verify(token))).toBe('claims');
    });
  });

  describe('refused: a scope not in the manifest', () => {
    it('refuses a scope the calling service did not declare', async () => {
      expect(
        await rejection(verifier().verify(await serviceToken(['payroll:run']))),
      ).toBe('scope');
    });

    it('refuses a scope that another service declared', async () => {
      expect(
        await rejection(verifier().verify(await serviceToken(['items:read']))),
      ).toBe('scope');
    });

    it('refuses the whole token when one scope of several is undeclared', async () => {
      expect(
        await rejection(
          verifier().verify(
            await serviceToken(['contacts:read', 'payroll:run']),
          ),
        ),
      ).toBe('scope');
    });

    it('refuses every scope when no registry is configured', async () => {
      const withoutRegistry = createTokenVerifier({
        audience: 'core',
        trustedIssuers: { sales: [sales.publicJwk] },
        clock,
      });
      expect(
        await rejection(withoutRegistry.verify(await serviceToken())),
      ).toBe('scope');
      expect(
        await rejection(withoutRegistry.verify(await serviceToken([]))),
      ).toBe('ACCEPTED');
    });

    it.each(['*', 'contacts', 'contacts:*', 'Contacts:read', ' contacts:read'])(
      'refuses the malformed scope %p',
      async (scope) => {
        expect(
          await rejection(verifier().verify(await serviceToken([scope]))),
        ).toBe('scope');
        expect(isScope(scope)).toBe(false);
      },
    );
  });

  describe('refused: HS256 and other algorithms', () => {
    it('refuses an HS256 token signed with the public key as the secret', async () => {
      // The classic algorithm-confusion attack: the attacker knows the public
      // key, and hopes the verifier uses it as an HMAC secret.
      const publicPem = await exportSPKI(
        (await importJWK(gateway.publicJwk, 'ES256')) as Parameters<
          typeof exportSPKI
        >[0],
      );
      const issuedAt = Math.floor(clock.now().getTime() / 1_000);
      const header = base64url(
        JSON.stringify({
          alg: 'HS256',
          kid: gateway.publicJwk.kid,
          typ: 'JWT',
        }),
      );
      const payload = base64url(
        JSON.stringify({
          iss: 'gateway',
          aud: 'core',
          sub: USER,
          iat: issuedAt,
          exp: issuedAt + 60,
          jti: nextId(),
          token_use: 'user',
          tid: TENANT,
          bid: BUSINESS,
          perms: ['payroll_runs:pay'],
        }),
      );
      const signature = createHmac('sha256', publicPem)
        .update(`${header}.${payload}`)
        .digest('base64url');

      expect(
        await rejection(verifier().verify(`${header}.${payload}.${signature}`)),
      ).toBe('algorithm');
    });

    it('refuses an unsigned token with alg "none"', async () => {
      const real = await userToken();
      const [, payload] = real.split('.');
      const header = base64url(
        JSON.stringify({ alg: 'none', kid: gateway.publicJwk.kid }),
      );
      expect(await rejection(verifier().verify(`${header}.${payload}.`))).toBe(
        'algorithm',
      );
    });

    it.each(['RS256', 'ES384', 'PS256', 'EdDSA', 'es256'])(
      'refuses a token whose header says %s',
      async (alg) => {
        const real = await userToken();
        const [, payload, signature] = real.split('.');
        const header = base64url(
          JSON.stringify({ alg, kid: gateway.publicJwk.kid, typ: 'JWT' }),
        );
        expect(
          await rejection(
            verifier().verify(`${header}.${payload}.${signature}`),
          ),
        ).toBe('algorithm');
      },
    );
  });

  describe('refused: wrong signer', () => {
    it('refuses a payload changed after signing', async () => {
      const real = await userToken();
      const [header, payload, signature] = real.split('.') as [
        string,
        string,
        string,
      ];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const tampered = base64url(
        JSON.stringify({ ...claims, perms: ['payroll_runs:pay'] }),
      );
      expect(
        await rejection(
          verifier().verify(`${header}.${tampered}.${signature}`),
        ),
      ).toBe('signature');
    });

    it('refuses a token that claims to be from the gateway but is signed by another service', async () => {
      // sales signs with its own key, naming its own kid, and claims iss "gateway".
      const impersonation = await forge(sales, { iss: 'gateway' });
      expect(await rejection(verifier().verify(impersonation))).toBe(
        'unknown-key',
      );

      // Same, but naming the gateway's kid.
      const withGatewayKid = await forge(
        sales,
        { iss: 'gateway' },
        { kid: gateway.publicJwk.kid },
      );
      expect(await rejection(verifier().verify(withGatewayKid))).toBe(
        'signature',
      );
    });

    it('refuses a user token minted by a service that may not mint them', async () => {
      const selfMinted = await forge(sales, { iss: 'sales' });
      expect(await rejection(verifier().verify(selfMinted))).toBe(
        'issuer-not-allowed',
      );
    });

    it('refuses an issuer it does not know, and a key id it does not know', async () => {
      const stranger = await generateEs256KeyPair('stranger-1');
      expect(
        await rejection(
          verifier().verify(await forge(stranger, { iss: 'stranger' })),
        ),
      ).toBe('unknown-issuer');
      expect(
        await rejection(
          verifier().verify(
            await forge(gateway, {}, { kid: 'gateway-retired' }),
          ),
        ),
      ).toBe('unknown-key');
    });

    it('refuses a service token whose subject is not its issuer', async () => {
      const token = await forge(sales, {
        iss: 'sales',
        sub: 'core',
        token_use: 'service',
        scopes: ['contacts:read'],
      });
      expect(await rejection(verifier().verify(token))).toBe('claims');
    });
  });

  describe('refused: bad claims', () => {
    it.each([
      ['an unknown token_use', { token_use: 'admin' }],
      ['no token_use', { token_use: undefined }],
      ['a tenant that is not a UUID', { tid: 'tenant-1' }],
      ['no business', { bid: undefined }],
      ['a branch that is not a UUID', { brid: 'main' }],
      ['a subject that is not a UUID', { sub: 'henson' }],
      ['permissions that are not a list of strings', { perms: 'all' }],
      ['no token id', { jti: undefined }],
      ['no issued-at', { iat: undefined }],
    ])('refuses a user token with %s', async (_label, claims) => {
      expect(
        await rejection(verifier().verify(await forge(gateway, claims))),
      ).toBe('claims');
    });
  });

  describe('what the caller is told', () => {
    it('is always the same 401, whatever the reason', async () => {
      const errors = await Promise.all(
        [undefined, 'garbage', await userToken('sales')].map((token) =>
          verifier()
            .verify(token)
            .catch((error: unknown) => error as TokenError),
        ),
      );
      for (const error of errors) {
        expect(error).toBeInstanceOf(TokenError);
        expect(error).toMatchObject({
          status: 401,
          code: 'UNAUTHENTICATED',
          message: 'Authentication is required.',
          headers: { 'WWW-Authenticate': 'Bearer' },
          details: {},
        });
      }
      expect(
        new Set(errors.map((error) => (error as TokenError).reason)).size,
      ).toBe(3);
    });
  });

  describe('configuration', () => {
    it('refuses to sign with a key that is not a P-256 private key with a kid', () => {
      const withoutKid = { ...gateway.privateJwk, kid: undefined };
      for (const bad of [
        gateway.publicJwk,
        withoutKid,
        { ...gateway.privateJwk, crv: 'P-384' },
      ]) {
        expect(() =>
          createTokenSigner({
            issuer: 'gateway',
            privateJwk: bad as PrivateJwk,
          }),
        ).toThrow('The signing key must be a P-256 private JWK with a kid.');
      }
    });

    it('refuses to trust a private key, so one cannot be configured by mistake', () => {
      expect(() =>
        createTokenVerifier({
          audience: 'core',
          trustedIssuers: { gateway: [gateway.privateJwk] },
        }),
      ).toThrow(/must be a P-256 public JWK/);
    });

    it('refuses a registry with a malformed scope', () => {
      expect(() =>
        createServiceScopeRegistry({ sales: ['everything'] }),
      ).toThrow(/resource:action/);
    });
  });

  describe('serviceTokenHeaders', () => {
    it('produces a fresh bearer token for every call', async () => {
      const headers = serviceTokenHeaders(signer('sales', sales), {
        audience: 'core',
        scopes: ['contacts:read'],
      });
      const first = (await headers())['authorization'] as string;
      const second = (await headers())['authorization'] as string;
      expect(first).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(first).not.toBe(second);
      expect(
        await verifier().verify(first.replace('Bearer ', '')),
      ).toMatchObject({ kind: 'service', service: 'sales' });
    });
  });
});
