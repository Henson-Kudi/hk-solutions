import { isProductKey } from '@hk/contracts/product-manifest';
import {
  DomainError,
  err,
  isUuid,
  ok,
  type Result,
} from '@hk/platform/universal';
import { z } from 'zod';

/**
 * Offline sync: what a device sends up and what it pulls down.
 *
 * A device does not send rows. It sends commands: "this use case ran with
 * this input". The server runs the same use case again under the command's
 * id as the idempotency key, so a command pushed twice is applied once.
 * Changes come back through a per-business change feed.
 */

/** A use case, named by the product that owns it: "pos.completeSale". */
export type UseCaseName = `${string}.${string}`;

const USE_CASE = /^([a-z][a-z0-9_]*)\.([a-z][A-Za-z0-9]*)$/;

/** True for "<product>.<useCase>" where the product exists, or is "core". */
export const isUseCaseName = (value: unknown): value is UseCaseName => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = USE_CASE.exec(value);
  return match !== null && (match[1] === 'core' || isProductKey(match[1]));
};

/** The product (or "core") that owns a use case. */
export const ownerOf = (useCase: UseCaseName): string =>
  useCase.slice(0, useCase.indexOf('.'));

export interface SyncCommand<Payload = unknown> {
  /** A UUID v7 made on the device. Also the Idempotency-Key on the server. */
  commandId: string;
  deviceId: string;
  tenantId: string;
  businessId: string;
  branchId: string;
  userId: string;
  useCase: UseCaseName;
  /** The version of the payload's schema. */
  version: number;
  /** When the device ran the use case, by the device's clock. ISO 8601. */
  occurredAt: string;
  /** The change-feed cursor the device had when it ran the command. Empty before the first pull. */
  baseCursor: string;
  /** Validated by the use case's own schema, on the device and again on the server. */
  payload: Payload;
}

const uuid = z.string().refine(isUuid, 'must be a UUID');
const instant = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
    'must be an ISO 8601 instant',
  );

export const syncCommandSchema = z.object({
  commandId: uuid,
  deviceId: uuid,
  tenantId: uuid,
  businessId: uuid,
  branchId: uuid,
  userId: uuid,
  useCase: z
    .string()
    .refine(isUseCaseName, 'must be <product>.<useCase> for a known product'),
  version: z.number().int().min(1),
  occurredAt: instant,
  baseCursor: z.string().max(512),
  payload: z.unknown(),
});

const invalid = (code: string, error: z.ZodError): DomainError =>
  new DomainError(code, 'The sync message is malformed.', {
    details: {
      issues: error.issues.length,
      firstPath: error.issues[0]?.path.map(String).join('.') ?? '',
    },
  });

/** Checks the envelope of a command. The payload is checked later, by its use case. */
export const parseSyncCommand = (input: unknown): Result<SyncCommand> => {
  const parsed = syncCommandSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data as SyncCommand)
    : err(invalid('SYNC_COMMAND_INVALID', parsed.error));
};

/** The idempotency key under which the server runs a command. */
export const idempotencyKeyOf = (command: SyncCommand): string =>
  command.commandId;

/** Most commands in one push. */
export const MAX_COMMANDS_PER_PUSH = 100;

export interface SyncPushRequest {
  /** In the order the device ran them. The server applies them in this order. */
  commands: SyncCommand[];
}

export const syncPushRequestSchema = z.object({
  commands: z.array(syncCommandSchema).min(1).max(MAX_COMMANDS_PER_PUSH),
});

/**
 * Checks a push: every command is well formed, and all of them come from one
 * device and one business, which is the scope the caller was authenticated
 * for.
 */
export const parseSyncPushRequest = (
  input: unknown,
): Result<SyncPushRequest> => {
  const parsed = syncPushRequestSchema.safeParse(input);
  if (!parsed.success) {
    return err(invalid('SYNC_PUSH_INVALID', parsed.error));
  }
  const commands = parsed.data.commands as SyncCommand[];
  const first = commands[0] as SyncCommand;
  const mixed = commands.some(
    (command) =>
      command.deviceId !== first.deviceId ||
      command.tenantId !== first.tenantId ||
      command.businessId !== first.businessId,
  );
  if (mixed) {
    return err(
      new DomainError(
        'SYNC_PUSH_MIXED',
        'A push must hold the commands of one device and one business.',
      ),
    );
  }
  const ids = new Set(commands.map((command) => command.commandId));
  if (ids.size !== commands.length) {
    return err(
      new DomainError(
        'SYNC_PUSH_DUPLICATE',
        'A push must not hold the same command twice.',
      ),
    );
  }
  return ok({ commands });
};

/** Something the server changed while applying a command, for the device to show. */
export interface SyncAdjustment {
  /** Stable code: "document_number_assigned", "stock_negative". */
  code: string;
  /** Values that go with the code, such as the final document number. */
  details: Record<string, string | number | boolean | null>;
}

export type SyncCommandResult =
  /** The server did exactly what the device did. */
  | { commandId: string; status: 'applied' }
  /** Applied, but the server's outcome differs from the device's in the listed ways. */
  | {
      commandId: string;
      status: 'applied_with_adjustments';
      adjustments: SyncAdjustment[];
    }
  /** Not applied. The device keeps the command for the user to review. */
  | {
      commandId: string;
      status: 'rejected';
      /** A DomainError code, which the device translates. */
      reason: string;
      details?: Record<string, string | number | boolean | null>;
    };

export interface SyncPushResponse {
  /** One result per command, in the order they were sent. */
  results: SyncCommandResult[];
}

const adjustmentSchema = z.object({
  code: z.string().min(1),
  details: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});

export const syncCommandResultSchema = z.discriminatedUnion('status', [
  z.object({ commandId: uuid, status: z.literal('applied') }),
  z.object({
    commandId: uuid,
    status: z.literal('applied_with_adjustments'),
    adjustments: z.array(adjustmentSchema).min(1),
  }),
  z.object({
    commandId: uuid,
    status: z.literal('rejected'),
    reason: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    details: adjustmentSchema.shape.details.optional(),
  }),
]);

export const syncPushResponseSchema = z.object({
  results: z.array(syncCommandResultSchema),
});

/** One change to one row of a model the device keeps a copy of. */
export interface ChangeRecord {
  /** The read model: "core.contacts", "inventory.stock_levels". */
  model: string;
  op: 'upsert' | 'delete';
  id: string;
  /** The row's version after the change. The device ignores a change older than what it has. */
  version: number;
  /** ISO 8601. */
  changedAt: string;
  /** The row, for an upsert. Absent for a delete. */
  data?: Record<string, unknown>;
}

export interface ChangeFeedPage {
  changes: ChangeRecord[];
  /** Pass this as `cursor` to get what comes next. */
  nextCursor: string;
  /** True when more changes are waiting right now. */
  hasMore: boolean;
}

const MODEL = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export const changeRecordSchema = z
  .object({
    model: z.string().regex(MODEL, 'must be <owner>.<model>'),
    op: z.enum(['upsert', 'delete']),
    id: uuid,
    version: z.number().int().min(1),
    changedAt: instant,
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (change) => (change.op === 'upsert') === (change.data !== undefined),
    'an upsert carries data and a delete does not',
  );

export const changeFeedPageSchema = z.object({
  changes: z.array(changeRecordSchema),
  nextCursor: z.string().min(1).max(512),
  hasMore: z.boolean(),
});

/** Checks a page of the change feed on the device before it is applied. */
export const parseChangeFeedPage = (input: unknown): Result<ChangeFeedPage> => {
  const parsed = changeFeedPageSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data as ChangeFeedPage)
    : err(invalid('SYNC_CHANGES_INVALID', parsed.error));
};
