/**
 * The SQL that makes the audit table write-once for the application.
 *
 * A service connects as its app role. By default that role may select,
 * insert, update and delete in its schema. These statements take update,
 * delete and truncate away on the audit table, so the database itself
 * refuses to change or remove an event, whatever the application code does.
 *
 * They belong in the migration that creates the table. Needs Henson's
 * line-by-line review.
 *
 * What they do not stop: the table's owner and a superuser can still change
 * rows. That is what the hash chain is for: it cannot prevent such a change,
 * but it shows it.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const identifier = (value: string, what: string): string => {
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `${what} must be lower-case letters, digits and underscores.`,
    );
  }
  return value;
};

export interface WriteOnceOptions {
  /** The schema the table is in: "core". */
  schema: string;
  /** The role the service logs in as: "hk_core_app". */
  appRole: string;
}

export const auditWriteOnceStatements = (
  options: WriteOnceOptions,
): string[] => {
  const schema = identifier(options.schema, 'Schema name');
  const role = identifier(options.appRole, 'Role name');
  return [
    `revoke update, delete, truncate on table ${schema}.audit_events from ${role}`,
  ];
};
