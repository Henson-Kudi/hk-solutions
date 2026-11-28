import type {
  AccessUnitOfWork,
  DirectoryEntry,
  MembershipDirectory,
  MembershipRepository,
  RoleRepository,
} from '@hk/core/identity/application';
import {
  IDENTITY_ERRORS,
  SYSTEM_ROLE_KEYS,
  type MemberStatus,
  type Membership,
  type Role,
  type SystemRoleKey,
} from '@hk/core/identity/domain';
import {
  ScopedRepository,
  requireSystemTransaction,
  requireTenantContext,
  requireTenantTransaction,
  runWithTenantContext,
  withSystemTransaction,
  withTenantTransaction,
  type Database,
  type Row,
} from '@hk/platform/db';
import { DomainError, isDomainError } from '@hk/platform/universal';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { AccessTables } from './access-schema';

/**
 * Access repositories on PostgreSQL.
 *
 * Roles and memberships go through ScopedRepository, inside a tenant
 * transaction: every query is filtered by the business in the tenant
 * context, and row-level security refuses anything else. The directory is a
 * global table: written inside the tenant transaction that changes a
 * membership, read inside a system transaction.
 */

const stale = (): DomainError =>
  new DomainError(
    IDENTITY_ERRORS.CHANGED_MEANWHILE,
    'It was changed by someone else. Read it again and retry.',
    { kind: 'conflict' },
  );

/** Turns the platform's "stale" and "not found" into the one answer the ports promise. */
const orStale = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (
      isDomainError(error) &&
      (error.code === 'ROW_STALE_VERSION' || error.code === 'ROW_NOT_FOUND')
    ) {
      throw stale();
    }
    throw error;
  }
};

type RolesTable = AccessTables['roles'];
type MembershipsTable = AccessTables['memberships'];

const toRole = (row: Row<RolesTable>): Role => ({
  id: row.id,
  key: row.key as SystemRoleKey | null,
  name: row.name,
  permissions: row.permissions,
  version: row.version,
});

const toMembership = (row: Row<MembershipsTable>): Membership => ({
  id: row.id,
  userId: row.userId,
  roleId: row.roleId,
  branchIds: row.branchIds,
  status: row.status as MemberStatus,
  joinedAt: row.joinedAt.toISOString(),
  version: row.version,
});

class RoleRows extends ScopedRepository<RolesTable> {
  constructor(table: RolesTable) {
    super(table);
  }

  all = () => this.find();
  byId = (id: string) => this.findById(id);
  byKey = async (key: string) =>
    (await this.find(eq(this.table.key, key), { limit: 1 }))[0];
  add = (role: Role) =>
    this.insert({
      id: role.id,
      key: role.key,
      name: role.name,
      permissions: [...role.permissions],
    });
  change = (role: Role) =>
    this.update(role.id, role.version, {
      name: role.name,
      permissions: [...role.permissions],
    });
  drop = (id: string) => this.delete(id);
}

const systemOrder = (role: Role): number =>
  role.key === null
    ? SYSTEM_ROLE_KEYS.length
    : SYSTEM_ROLE_KEYS.indexOf(role.key);

export class PgRoleRepository implements RoleRepository {
  private readonly rows: RoleRows;

  constructor(tables: AccessTables) {
    this.rows = new RoleRows(tables.roles);
  }

  async list(): Promise<Role[]> {
    // A business has at most fifty roles, so the order is made here.
    return (await this.rows.all())
      .map(toRole)
      .sort(
        (a, b) =>
          systemOrder(a) - systemOrder(b) ||
          (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1),
      );
  }

  async findById(roleId: string): Promise<Role | null> {
    const row = await this.rows.byId(roleId);
    return row ? toRole(row) : null;
  }

  async findByKey(key: SystemRoleKey): Promise<Role | null> {
    const row = await this.rows.byKey(key);
    return row ? toRole(row) : null;
  }

  async create(role: Role): Promise<void> {
    await this.rows.add(role);
  }

  async update(role: Role): Promise<Role> {
    return toRole(await orStale(() => this.rows.change(role)));
  }

  remove(roleId: string): Promise<boolean> {
    return this.rows.drop(roleId);
  }
}

class MembershipRows extends ScopedRepository<MembershipsTable> {
  constructor(table: MembershipsTable) {
    super(table);
  }

  byId = (id: string) => this.findById(id);
  byUser = async (userId: string) =>
    (await this.find(eq(this.table.userId, userId), { limit: 1 }))[0];

  all = () =>
    this.transaction
      .select()
      .from(this.table)
      .where(this.scope())
      .orderBy(asc(this.table.joinedAt), asc(this.table.id));

  async countWithRole(roleId: string): Promise<number> {
    const rows = await this.transaction
      .select({ n: sql<number>`count(*)::int` })
      .from(this.table)
      .where(
        this.scope(
          and(eq(this.table.roleId, roleId), ne(this.table.status, 'removed')),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** Inserts, unless the person already has a membership here. */
  async addUnlessPresent(membership: Membership): Promise<boolean> {
    const context = requireTenantContext();
    const rows = await this.transaction
      .insert(this.table)
      .values({
        id: membership.id,
        tenantId: context.tenantId,
        businessId: context.businessId,
        createdBy: context.userId ?? null,
        userId: membership.userId,
        roleId: membership.roleId,
        branchIds:
          membership.branchIds === null ? null : [...membership.branchIds],
        status: membership.status,
        joinedAt: new Date(membership.joinedAt),
      })
      // The unique index decides, so two additions of one person at the
      // same moment cannot both succeed.
      .onConflictDoNothing({
        target: [this.table.businessId, this.table.userId],
      })
      .returning({ id: this.table.id });
    return rows.length > 0;
  }

  change = (membership: Membership) =>
    this.update(membership.id, membership.version, {
      roleId: membership.roleId,
      branchIds:
        membership.branchIds === null ? null : [...membership.branchIds],
      status: membership.status,
      joinedAt: new Date(membership.joinedAt),
    });
}

export class PgMembershipRepository implements MembershipRepository {
  private readonly rows: MembershipRows;

  constructor(tables: AccessTables) {
    this.rows = new MembershipRows(tables.memberships);
  }

  async findById(membershipId: string): Promise<Membership | null> {
    const row = await this.rows.byId(membershipId);
    return row ? toMembership(row) : null;
  }

  async findByUser(userId: string): Promise<Membership | null> {
    const row = await this.rows.byUser(userId);
    return row ? toMembership(row) : null;
  }

  async list(): Promise<Membership[]> {
    return (await this.rows.all()).map(toMembership);
  }

  countWithRole(roleId: string): Promise<number> {
    return this.rows.countWithRole(roleId);
  }

  async create(membership: Membership): Promise<void> {
    if (!(await this.rows.addUnlessPresent(membership))) {
      throw new DomainError(
        IDENTITY_ERRORS.MEMBER_EXISTS,
        'This person is already a member of the business.',
        { kind: 'conflict' },
      );
    }
  }

  async update(membership: Membership): Promise<Membership> {
    return toMembership(await orStale(() => this.rows.change(membership)));
  }
}

export class PgMembershipDirectory implements MembershipDirectory {
  constructor(private readonly tables: AccessTables) {}

  async set(entry: DirectoryEntry): Promise<void> {
    const { userBusinesses } = this.tables;
    // Written in the tenant transaction that changes the membership, and
    // only for that business: the line can never be about another one.
    const transaction = requireTenantTransaction();
    const context = requireTenantContext();
    if (
      entry.tenantId !== context.tenantId ||
      entry.businessId !== context.businessId
    ) {
      throw new DomainError(
        'DIRECTORY_SCOPE_MISMATCH',
        'A directory line can only be written for the business this work is running for.',
        { kind: 'invariant' },
      );
    }
    await transaction
      .insert(userBusinesses)
      .values({
        userId: entry.userId,
        businessId: entry.businessId,
        tenantId: entry.tenantId,
        active: entry.active,
      })
      .onConflictDoUpdate({
        target: [userBusinesses.userId, userBusinesses.businessId],
        set: {
          tenantId: entry.tenantId,
          active: entry.active,
          updatedAt: sql`now()`,
        },
      });
  }

  async find(
    userId: string,
    businessId: string,
  ): Promise<DirectoryEntry | null> {
    const { userBusinesses } = this.tables;
    const rows = await requireSystemTransaction()
      .select()
      .from(userBusinesses)
      .where(
        and(
          eq(userBusinesses.userId, userId),
          eq(userBusinesses.businessId, businessId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          userId: row.userId,
          tenantId: row.tenantId,
          businessId: row.businessId,
          active: row.active,
        }
      : null;
  }

  async listActive(userId: string): Promise<DirectoryEntry[]> {
    const { userBusinesses } = this.tables;
    const rows = await requireSystemTransaction()
      .select()
      .from(userBusinesses)
      .where(
        and(eq(userBusinesses.userId, userId), eq(userBusinesses.active, true)),
      )
      .orderBy(asc(userBusinesses.businessId));
    return rows.map((row) => ({
      userId: row.userId,
      tenantId: row.tenantId,
      businessId: row.businessId,
      active: row.active,
    }));
  }
}

/**
 * The access unit of work on PostgreSQL. `tenant` sets the tenant context
 * and opens a tenant transaction (or joins the one open for the same
 * business); `system` opens a transaction with no tenant.
 */
export const createPgAccessUnitOfWork = (
  database: Database,
): AccessUnitOfWork => ({
  tenant: (scope, action) =>
    runWithTenantContext(
      { tenantId: scope.tenantId, businessId: scope.businessId },
      () => withTenantTransaction(database, action),
    ),
  system: (action) => withSystemTransaction(database, action),
});
