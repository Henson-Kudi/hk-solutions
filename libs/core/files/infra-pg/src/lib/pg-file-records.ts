import type {
  FileRecords,
  NewFileRecord,
  UnitOfWork,
} from '@hk/core/files/application';
import {
  FILE_ERRORS,
  type ContentType,
  type FilePurpose,
  type FileRecord,
  type FileScope,
  type FileStatus,
} from '@hk/core/files/domain';
import {
  ScopedRepository,
  requireTenantContext,
  runWithTenantContext,
  withTenantTransaction,
  type Database,
  type NewRow,
  type Row,
} from '@hk/platform/db';
import { DomainError } from '@hk/platform/universal';
import { and, eq, sql } from 'drizzle-orm';
import type { FilesTable } from './schema';

const notFound = (): DomainError =>
  new DomainError(FILE_ERRORS.NOT_FOUND, 'The file was not found.', {
    kind: 'not-found',
  });

/**
 * The table access. It extends ScopedRepository for the tenant filter and
 * the stamped insert, and is kept private to this file: the port below is
 * what the rest of the code sees.
 */
class FileRows extends ScopedRepository<FilesTable> {
  constructor(table: FilesTable) {
    super(table);
  }

  add(values: NewRow<FilesTable>): Promise<Row<FilesTable>> {
    return this.insert(values);
  }

  byId(id: string): Promise<Row<FilesTable> | undefined> {
    return this.findById(id);
  }

  /** Moves a row from one status to another, only if it is in `from`. */
  async move(
    id: string,
    from: FileStatus,
    to: FileStatus,
    facts: { size?: number; sha256?: string } = {},
  ): Promise<Row<FilesTable> | undefined> {
    const rows = await this.transaction
      .update(this.table)
      .set({
        status: to,
        ...facts,
        version: sql`${this.table.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        this.scope(and(eq(this.table.id, id), eq(this.table.status, from))),
      )
      .returning();
    return rows[0];
  }

  async removePending(id: string): Promise<void> {
    await this.transaction
      .delete(this.table)
      .where(
        this.scope(
          and(eq(this.table.id, id), eq(this.table.status, 'pending')),
        ),
      );
  }
}

/**
 * File records on PostgreSQL. Every method runs inside a tenant transaction
 * for the business of the tenant context (see createPgUnitOfWork).
 */
export class PgFileRecords implements FileRecords {
  private readonly rows: FileRows;

  constructor(table: FilesTable) {
    this.rows = new FileRows(table);
  }

  /** The scope a caller names must be the business the work is running for. */
  private assertScope(scope: FileScope): void {
    const context = requireTenantContext();
    if (
      scope.tenantId !== context.tenantId ||
      scope.businessId !== context.businessId
    ) {
      throw new DomainError(
        'FILE_SCOPE_MISMATCH',
        'The file scope is not the business this work is running for.',
        { kind: 'invariant' },
      );
    }
  }

  async create(scope: FileScope, record: NewFileRecord): Promise<FileRecord> {
    this.assertScope(scope);
    const row = await this.rows.add({
      id: record.id,
      purpose: record.purpose,
      name: record.name,
      contentType: record.contentType,
      status: 'pending',
      size: null,
      sha256: null,
      objectKey: record.objectKey,
      uploadedAt: new Date(record.createdAt),
      uploadedBy: record.createdBy,
    });
    return toRecord(row);
  }

  async find(scope: FileScope, id: string): Promise<FileRecord | null> {
    this.assertScope(scope);
    const row = await this.rows.byId(id);
    return row ? toRecord(row) : null;
  }

  async markStored(
    scope: FileScope,
    id: string,
    stored: { size: number; sha256: string },
  ): Promise<FileRecord> {
    this.assertScope(scope);
    const row = await this.rows.move(id, 'pending', 'stored', stored);
    if (!row) throw notFound();
    return toRecord(row);
  }

  async markDeleted(scope: FileScope, id: string): Promise<FileRecord> {
    this.assertScope(scope);
    const row = await this.rows.move(id, 'stored', 'deleted');
    if (!row) throw notFound();
    return toRecord(row);
  }

  async discardPending(scope: FileScope, id: string): Promise<void> {
    this.assertScope(scope);
    await this.rows.removePending(id);
  }
}

const toRecord = (row: Row<FilesTable>): FileRecord => ({
  tenantId: row.tenantId,
  businessId: row.businessId,
  id: row.id,
  purpose: row.purpose as FilePurpose,
  name: row.name,
  contentType: row.contentType as ContentType,
  status: row.status as FileStatus,
  size: row.size,
  sha256: row.sha256,
  objectKey: row.objectKey,
  createdAt: row.uploadedAt.toISOString(),
  createdBy: row.uploadedBy,
});

/**
 * The unit of work on PostgreSQL: a tenant transaction for the business.
 * Record calls made inside `action` commit or roll back together.
 */
export const createPgUnitOfWork = (database: Database): UnitOfWork => ({
  run: (scope, action) =>
    runWithTenantContext(
      { tenantId: scope.tenantId, businessId: scope.businessId },
      () => withTenantTransaction(database, action),
    ),
});
