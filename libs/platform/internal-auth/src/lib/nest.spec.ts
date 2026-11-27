import { getTenantContext, type TenantContext } from '@hk/platform/db';
import {
  createMemoryLogger,
  type Logger,
  type MemoryLogger,
} from '@hk/platform/logger';
import { LOGGER, LoggerModule, setupHttpApp } from '@hk/platform/nest';
import { createUuidV7Generator } from '@hk/platform/universal';
import {
  Controller,
  Get,
  Inject,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  CurrentPrincipal,
  InternalAuthGuard,
  Public,
  RequirePermission,
  RequireScope,
  internalAuth,
} from './nest';
import { createServiceScopeRegistry, type Principal } from './principal';
import {
  createTokenSigner,
  createTokenVerifier,
  generateEs256KeyPair,
  type TokenSigner,
} from './tokens';

const nextId = createUuidV7Generator();

const USER = nextId();
const TENANT = nextId();
const BUSINESS = nextId();
const BRANCH = nextId();

@Controller('things')
class ThingsController {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  @Get('whoami')
  whoami(@CurrentPrincipal() principal: Principal) {
    this.logger.info('whoami handled');
    return { principal, tenant: getTenantContext() ?? null };
  }

  @Get('open')
  @Public()
  open(@CurrentPrincipal() principal: Principal | undefined) {
    return { principal: principal ?? null, tenant: getTenantContext() ?? null };
  }

  @Post('issue')
  @RequirePermission('invoices:issue')
  issue() {
    return { issued: true };
  }

  @Post('void')
  @RequirePermission('invoices:issue', 'invoices:void')
  void() {
    return { voided: true };
  }

  @Get('contacts')
  @RequireScope('contacts:read')
  contacts() {
    return { contacts: [] };
  }
}

@Controller('status')
@Public()
class StatusController {
  @Get()
  status() {
    return { ok: true };
  }
}

describe('internal auth over HTTP', () => {
  let app: INestApplication;
  let memory: MemoryLogger;
  let gateway: TokenSigner;
  let sales: TokenSigner;

  const http = () => request(app.getHttpServer());

  const userToken = (
    permissions: string[] = ['invoices:issue'],
    audience = 'core',
  ) =>
    gateway.userToken({
      audience,
      userId: USER,
      tenantId: TENANT,
      businessId: BUSINESS,
      branchId: BRANCH,
      permissions,
    });

  const bearer = async (token: Promise<string> | string) =>
    `Bearer ${await token}`;

  beforeAll(async () => {
    const gatewayKeys = await generateEs256KeyPair('gateway-1');
    const salesKeys = await generateEs256KeyPair('sales-1');
    gateway = createTokenSigner({
      issuer: 'gateway',
      privateJwk: gatewayKeys.privateJwk,
    });
    sales = createTokenSigner({
      issuer: 'sales',
      privateJwk: salesKeys.privateJwk,
    });
    const verifier = createTokenVerifier({
      audience: 'core',
      trustedIssuers: {
        gateway: [gatewayKeys.publicJwk],
        sales: [salesKeys.publicJwk],
      },
      scopes: createServiceScopeRegistry({
        sales: ['contacts:read', 'items:read'],
      }),
    });

    memory = createMemoryLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.register(memory.logger)],
      controllers: [ThingsController, StatusController],
      providers: [{ provide: APP_GUARD, useClass: InternalAuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Same order as a real service: request id first, then the caller.
    app.use(internalAuth({ verifier, logger: memory.logger }));
    setupHttpApp(app, { logger: memory.logger });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    memory.clear();
  });

  describe('deny by default', () => {
    it('answers 401 without a token', async () => {
      const response = await http().get('/things/whoami').expect(401);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(JSON.parse(response.text)).toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
        detail: 'Authentication is required.',
      });
    });

    it.each([
      ['a token for another service', () => userToken([], 'sales'), 'audience'],
      ['garbage', () => 'not.a.token', 'malformed'],
      [
        'a scope the caller did not declare',
        () => sales.serviceToken({ audience: 'core', scopes: ['payroll:run'] }),
        'scope',
      ],
    ])(
      'answers the same 401 for %s, and logs the reason',
      async (_label, make, reason) => {
        const response = await http()
          .get('/things/whoami')
          .set('Authorization', await bearer(make()))
          .expect(401);
        const body = JSON.parse(response.text);
        expect(body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
        // The caller learns nothing about which check failed.
        expect(response.text).not.toContain(reason);
        expect(body).not.toHaveProperty('details');
        expect(memory.entries).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            message: 'internal token rejected',
            reason,
          }),
        );
      },
    );

    it.each([
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer  two-spaces',
      'bearer x.y.z',
      'Token abc',
    ])('answers 401 for the Authorization header %p', async (header) => {
      await http()
        .get('/things/whoami')
        .set('Authorization', header)
        .expect(401);
    });

    it('never logs the token', async () => {
      const token = await userToken([], 'sales');
      await http()
        .get('/things/whoami')
        .set('Authorization', `Bearer ${token}`);
      expect(memory.text()).not.toContain(token);
      expect(memory.text()).not.toContain(token.split('.')[2]);
    });
  });

  describe('a verified user', () => {
    it('reaches the handler, which receives the principal', async () => {
      const response = await http()
        .get('/things/whoami')
        .set('Authorization', await bearer(userToken(['invoices:issue'])))
        .expect(200);
      expect(response.body.principal).toEqual({
        kind: 'user',
        userId: USER,
        tenantId: TENANT,
        businessId: BUSINESS,
        branchId: BRANCH,
        permissions: ['invoices:issue'],
        issuer: 'gateway',
        tokenId: expect.any(String),
      });
    });

    it('runs the request in the tenant context of the token', async () => {
      const response = await http()
        .get('/things/whoami')
        .set('Authorization', await bearer(userToken()))
        .expect(200);
      const tenant: TenantContext = response.body.tenant;
      expect(tenant).toEqual({
        tenantId: TENANT,
        businessId: BUSINESS,
        branchId: BRANCH,
        userId: USER,
      });
    });

    it('puts the caller on every log line of the request', async () => {
      await http()
        .get('/things/whoami')
        .set('Authorization', await bearer(userToken()))
        .expect(200);
      const expected = { tenantId: TENANT, businessId: BUSINESS, userId: USER };
      expect(
        memory.entries.find((entry) => entry.message === 'whoami handled'),
      ).toMatchObject(expected);
      expect(
        memory.entries.find((entry) => entry.message === 'request completed'),
      ).toMatchObject(expected);
    });

    it('keeps concurrent requests of different businesses apart', async () => {
      const otherBusiness = nextId();
      const [first, second] = await Promise.all([
        http()
          .get('/things/whoami')
          .set('Authorization', await bearer(userToken())),
        http()
          .get('/things/whoami')
          .set(
            'Authorization',
            await bearer(
              gateway.userToken({
                audience: 'core',
                userId: USER,
                tenantId: TENANT,
                businessId: otherBusiness,
                permissions: [],
              }),
            ),
          ),
      ]);
      expect(first.body.tenant.businessId).toBe(BUSINESS);
      expect(second.body.tenant.businessId).toBe(otherBusiness);
    });
  });

  describe('@RequirePermission', () => {
    it('lets a user with the permission through', async () => {
      await http()
        .post('/things/issue')
        .set('Authorization', await bearer(userToken(['invoices:issue'])))
        .expect(201);
    });

    it('answers 403 to a user without it', async () => {
      const response = await http()
        .post('/things/issue')
        .set('Authorization', await bearer(userToken(['invoices:view'])))
        .expect(403);
      expect(JSON.parse(response.text)).toMatchObject({
        status: 403,
        code: 'PERMISSION_DENIED',
      });
    });

    it('needs every permission listed', async () => {
      await http()
        .post('/things/void')
        .set('Authorization', await bearer(userToken(['invoices:issue'])))
        .expect(403);
      await http()
        .post('/things/void')
        .set(
          'Authorization',
          await bearer(userToken(['invoices:issue', 'invoices:void'])),
        )
        .expect(201);
    });

    it('answers 403 to a service, whatever its scopes', async () => {
      await http()
        .post('/things/issue')
        .set(
          'Authorization',
          await bearer(
            sales.serviceToken({ audience: 'core', scopes: ['contacts:read'] }),
          ),
        )
        .expect(403);
    });

    it('still answers 401, not 403, without a token', async () => {
      await http().post('/things/issue').expect(401);
    });
  });

  describe('@RequireScope', () => {
    it('lets a service with the scope through, without a tenant context', async () => {
      await http()
        .get('/things/contacts')
        .set(
          'Authorization',
          await bearer(
            sales.serviceToken({ audience: 'core', scopes: ['contacts:read'] }),
          ),
        )
        .expect(200);

      const whoami = await http()
        .get('/things/whoami')
        .set(
          'Authorization',
          await bearer(sales.serviceToken({ audience: 'core', scopes: [] })),
        )
        .expect(200);
      expect(whoami.body).toMatchObject({
        principal: { kind: 'service', service: 'sales' },
        tenant: null,
      });
      expect(
        memory.entries.find((entry) => entry.message === 'whoami handled'),
      ).toMatchObject({ callerService: 'sales' });
    });

    it('answers 403 to a service whose token lacks the scope', async () => {
      await http()
        .get('/things/contacts')
        .set(
          'Authorization',
          await bearer(
            sales.serviceToken({ audience: 'core', scopes: ['items:read'] }),
          ),
        )
        .expect(403);
    });

    it('answers 403 to a user', async () => {
      await http()
        .get('/things/contacts')
        .set('Authorization', await bearer(userToken(['contacts:read'])))
        .expect(403);
    });
  });

  describe('@Public()', () => {
    it('needs no token, on a handler and on a whole controller', async () => {
      const open = await http().get('/things/open').expect(200);
      expect(open.body).toEqual({ principal: null, tenant: null });
      await http().get('/status').expect(200);
    });

    it('still identifies a caller who sends a valid token', async () => {
      const response = await http()
        .get('/things/open')
        .set('Authorization', await bearer(userToken()))
        .expect(200);
      expect(response.body.principal).toMatchObject({
        kind: 'user',
        userId: USER,
      });
      expect(response.body.tenant).toMatchObject({ businessId: BUSINESS });
    });

    it('treats a caller with a bad token as anonymous, not as an error', async () => {
      const response = await http()
        .get('/things/open')
        .set('Authorization', 'Bearer not.a.token')
        .expect(200);
      expect(response.body).toEqual({ principal: null, tenant: null });
    });
  });
});

describe('InternalAuthGuard without the middleware', () => {
  it('fails closed with a 500 instead of letting everyone in', async () => {
    const memory = createMemoryLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.register(memory.logger)],
      controllers: [StatusController, ThingsController],
      providers: [{ provide: APP_GUARD, useClass: InternalAuthGuard }],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    setupHttpApp(app, { logger: memory.logger });
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/things/whoami')
        .expect(500);
      expect(JSON.parse(response.text)).toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      // A public route is unaffected.
      await request(app.getHttpServer()).get('/status').expect(200);
    } finally {
      await app.close();
    }
  });
});
