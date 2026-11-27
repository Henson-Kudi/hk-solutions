import {
  MAX_COMMANDS_PER_PUSH,
  idempotencyKeyOf,
  isUseCaseName,
  ownerOf,
  parseChangeFeedPage,
  parseSyncCommand,
  parseSyncPushRequest,
  syncCommandResultSchema,
  syncPushResponseSchema,
  type SyncCommand,
} from './sync';

const id = (n: number): string =>
  `018f2c3a-7b1e-7000-8000-${n.toString(16).padStart(12, '0')}`;

const command = (
  overrides: Partial<Record<keyof SyncCommand, unknown>> = {},
) => ({
  commandId: id(1),
  deviceId: id(100),
  tenantId: id(200),
  businessId: id(201),
  branchId: id(202),
  userId: id(300),
  useCase: 'pos.completeSale',
  version: 1,
  occurredAt: '2026-11-27T10:00:00.000Z',
  baseCursor: 'c-0042',
  payload: { lines: [{ itemId: id(400), quantity: '2' }] },
  ...overrides,
});

const errorOf = (result: { ok: boolean; error?: { code: string } }): string =>
  result.ok ? 'OK' : (result.error as { code: string }).code;

describe('use case names', () => {
  it.each([
    'pos.completeSale',
    'sales.createInvoice',
    'core.createContact',
    'multi_business.consolidate',
  ])('accepts %s', (name) => {
    expect(isUseCaseName(name)).toBe(true);
  });

  it.each([
    'completeSale',
    'pos.',
    '.completeSale',
    'POS.completeSale',
    'pos.complete-sale',
    'pos.CompleteSale',
    'warehouse.count',
    'pos.complete.sale',
    '',
    5,
  ])('rejects %p', (name) => {
    expect(isUseCaseName(name)).toBe(false);
  });

  it('names the owner', () => {
    expect(ownerOf('pos.completeSale')).toBe('pos');
    expect(ownerOf('core.createContact')).toBe('core');
  });
});

describe('parseSyncCommand', () => {
  it('accepts a well-formed command and leaves the payload as it is', () => {
    const result = parseSyncCommand(command());
    expect(result).toEqual({ ok: true, value: command() });
  });

  it('accepts an empty cursor, as a device has before its first pull', () => {
    expect(parseSyncCommand(command({ baseCursor: '' })).ok).toBe(true);
  });

  it('drops fields it does not know', () => {
    const result = parseSyncCommand({ ...command(), isAdmin: true });
    expect(result.ok && result.value).not.toHaveProperty('isAdmin');
  });

  it.each([
    ['a command id that is not a UUID', { commandId: 'cmd-1' }],
    ['a missing device', { deviceId: undefined }],
    ['a tenant that is not a UUID', { tenantId: 'acme' }],
    ['a missing branch', { branchId: undefined }],
    ['a use case of an unknown product', { useCase: 'warehouse.count' }],
    ['a version of zero', { version: 0 }],
    ['a fractional version', { version: 1.5 }],
    ['a version sent as a string', { version: '1' }],
    ['a time that is not an instant', { occurredAt: '27/11/2026' }],
    ['a cursor that is not a string', { baseCursor: 42 }],
    ['an oversized cursor', { baseCursor: 'x'.repeat(513) }],
  ])('rejects %s', (_label, overrides) => {
    expect(errorOf(parseSyncCommand(command(overrides)))).toBe(
      'SYNC_COMMAND_INVALID',
    );
  });

  it('says where the problem is without quoting the payload', () => {
    const result = parseSyncCommand(
      command({ version: 0, payload: { cardNumber: '4111111111111111' } }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { details: { issues: 1, firstPath: 'version' } },
    });
    expect(JSON.stringify(result)).not.toContain('4111111111111111');
  });

  it.each([null, undefined, 'command', 42, []])('rejects %p', (input) => {
    expect(errorOf(parseSyncCommand(input))).toBe('SYNC_COMMAND_INVALID');
  });

  it('uses the command id as the idempotency key', () => {
    const parsed = parseSyncCommand(command());
    expect(parsed.ok && idempotencyKeyOf(parsed.value)).toBe(id(1));
  });
});

describe('parseSyncPushRequest', () => {
  it('accepts commands of one device and one business, in order', () => {
    const commands = [
      command(),
      command({ commandId: id(2) }),
      command({ commandId: id(3) }),
    ];
    const result = parseSyncPushRequest({ commands });
    expect(result.ok && result.value.commands.map((c) => c.commandId)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
  });

  it('accepts a full batch and rejects one command more', () => {
    const batch = (size: number) => ({
      commands: Array.from({ length: size }, (_, index) =>
        command({ commandId: id(index + 1) }),
      ),
    });
    expect(parseSyncPushRequest(batch(MAX_COMMANDS_PER_PUSH)).ok).toBe(true);
    expect(
      errorOf(parseSyncPushRequest(batch(MAX_COMMANDS_PER_PUSH + 1))),
    ).toBe('SYNC_PUSH_INVALID');
  });

  it('rejects an empty push and one malformed command among good ones', () => {
    expect(errorOf(parseSyncPushRequest({ commands: [] }))).toBe(
      'SYNC_PUSH_INVALID',
    );
    const result = parseSyncPushRequest({
      commands: [command(), command({ commandId: 'bad' })],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'SYNC_PUSH_INVALID',
        details: { firstPath: 'commands.1.commandId' },
      },
    });
  });

  it.each([
    ['another device', { deviceId: id(101) }],
    ['another tenant', { tenantId: id(250) }],
    ['another business', { businessId: id(251) }],
  ])('rejects a push that mixes in a command of %s', (_label, overrides) => {
    expect(
      errorOf(
        parseSyncPushRequest({
          commands: [command(), command({ commandId: id(2), ...overrides })],
        }),
      ),
    ).toBe('SYNC_PUSH_MIXED');
  });

  it('allows commands of different branches and users of one business', () => {
    expect(
      parseSyncPushRequest({
        commands: [
          command(),
          command({ commandId: id(2), branchId: id(203), userId: id(301) }),
        ],
      }).ok,
    ).toBe(true);
  });

  it('rejects the same command twice in one push', () => {
    expect(
      errorOf(parseSyncPushRequest({ commands: [command(), command()] })),
    ).toBe('SYNC_PUSH_DUPLICATE');
  });
});

describe('command results', () => {
  it.each([
    [{ commandId: id(1), status: 'applied' }],
    [
      {
        commandId: id(1),
        status: 'applied_with_adjustments',
        adjustments: [
          {
            code: 'document_number_assigned',
            details: { number: 'INV-YDE-2026-00042' },
          },
          {
            code: 'stock_negative',
            details: { itemId: id(400), available: -2 },
          },
        ],
      },
    ],
    [{ commandId: id(1), status: 'rejected', reason: 'CASH_SESSION_CLOSED' }],
    [
      {
        commandId: id(1),
        status: 'rejected',
        reason: 'PRODUCT_NOT_ENABLED',
        details: { product: 'pos' },
      },
    ],
  ])('accepts %j', (result) => {
    expect(syncCommandResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ['an unknown status', { commandId: id(1), status: 'pending' }],
    [
      'adjustments without any',
      { commandId: id(1), status: 'applied_with_adjustments', adjustments: [] },
    ],
    ['a rejection without a reason', { commandId: id(1), status: 'rejected' }],
    [
      'a reason that is a sentence',
      { commandId: id(1), status: 'rejected', reason: 'Session is closed' },
    ],
    ['no command id', { status: 'applied' }],
  ])('rejects %s', (_label, result) => {
    expect(syncCommandResultSchema.safeParse(result).success).toBe(false);
  });

  it('accepts a response with one result per command', () => {
    expect(
      syncPushResponseSchema.safeParse({
        results: [
          { commandId: id(1), status: 'applied' },
          {
            commandId: id(2),
            status: 'rejected',
            reason: 'CASH_SESSION_CLOSED',
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('parseChangeFeedPage', () => {
  const upsert = {
    model: 'core.contacts',
    op: 'upsert',
    id: id(500),
    version: 3,
    changedAt: '2026-11-27T10:05:00.000Z',
    data: { name: 'Ada', balance: { amount: '1500', currency: 'XAF' } },
  };
  const removal = {
    model: 'inventory.stock_levels',
    op: 'delete',
    id: id(501),
    version: 7,
    changedAt: '2026-11-27T10:06:00.000Z',
  };

  it('accepts a page of upserts and deletes', () => {
    const page = {
      changes: [upsert, removal],
      nextCursor: 'c-0044',
      hasMore: false,
    };
    expect(parseChangeFeedPage(page)).toEqual({ ok: true, value: page });
  });

  it('accepts an empty page', () => {
    expect(
      parseChangeFeedPage({ changes: [], nextCursor: 'c-0044', hasMore: false })
        .ok,
    ).toBe(true);
  });

  it.each([
    ['an upsert without data', { ...upsert, data: undefined }],
    ['a delete with data', { ...removal, data: { name: 'x' } }],
    ['a model without an owner', { ...upsert, model: 'contacts' }],
    ['an unknown operation', { ...upsert, op: 'patch' }],
    ['a version of zero', { ...upsert, version: 0 }],
    ['an id that is not a UUID', { ...upsert, id: 'c-1' }],
    ['a time that is not an instant', { ...upsert, changedAt: 'now' }],
  ])('rejects a page holding %s', (_label, change) => {
    expect(
      errorOf(
        parseChangeFeedPage({
          changes: [change],
          nextCursor: 'c',
          hasMore: false,
        }),
      ),
    ).toBe('SYNC_CHANGES_INVALID');
  });

  it('rejects a page without a cursor to continue from', () => {
    expect(
      errorOf(
        parseChangeFeedPage({ changes: [], nextCursor: '', hasMore: true }),
      ),
    ).toBe('SYNC_CHANGES_INVALID');
    expect(errorOf(parseChangeFeedPage({ changes: [], hasMore: false }))).toBe(
      'SYNC_CHANGES_INVALID',
    );
  });
});
