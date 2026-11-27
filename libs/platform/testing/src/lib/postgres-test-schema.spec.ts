import { text, uuid } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import {
  createTestSchema,
  deferred,
  postgresTestUrl,
  waitFor,
} from './postgres-test-schema';

const adminUrl = postgresTestUrl();
const describeWithPostgres = adminUrl ? describe : describe.skip;

describe('test setup', () => {
  it('has a PostgreSQL to test against when running in CI', () => {
    if (process.env['CI']) {
      expect(adminUrl).toBeDefined();
    }
  });
});

describe('deferred', () => {
  it('resolves and rejects from outside', async () => {
    const value = deferred<number>();
    value.resolve(7);
    await expect(value.promise).resolves.toBe(7);

    const failure = deferred();
    failure.reject(new Error('no'));
    await expect(failure.promise).rejects.toThrow('no');
  });
});

describe('waitFor', () => {
  it('returns once the condition holds', async () => {
    let calls = 0;
    await waitFor(() => (calls += 1) >= 3);
    expect(calls).toBe(3);
  });

  it('throws when the condition never holds', async () => {
    await expect(waitFor(() => false, 60)).rejects.toThrow(/not met in time/);
  });
});

describe('createTestSchema', () => {
  it('refuses a prefix that is not lower-case letters', async () => {
    await expect(
      createTestSchema({
        adminUrl: 'postgres://unused',
        prefix: 'bad; drop',
        define: () => ({}),
      }),
    ).rejects.toThrow(/lower-case letters/);
  });
});

describeWithPostgres('createTestSchema against a real PostgreSQL', () => {
  it('creates tables an app role can use but does not own, and removes everything', async () => {
    const schema = await createTestSchema({
      adminUrl: adminUrl as string,
      prefix: 'testing',
      define: (target) => ({
        things: target.table('things', {
          id: uuid('id').primaryKey(),
          name: text('name').notNull(),
        }),
      }),
    });
    const app = new Client({ connectionString: schema.appUrl });
    await app.connect();

    try {
      expect(schema.name).toMatch(/^spec_testing_[a-z0-9_]+$/);

      await app.query(
        `insert into ${schema.name}.things (id, name) values (gen_random_uuid(), 'a')`,
      );
      const rows = await app.query(`select name from ${schema.name}.things`);
      expect(rows.rows).toEqual([{ name: 'a' }]);

      const role = await app.query(
        `select r.rolsuper, r.rolbypassrls,
                (select tableowner = current_user from pg_tables
                  where schemaname = $1 and tablename = 'things') as owns_table
           from pg_roles r where r.rolname = current_user`,
        [schema.name],
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        owns_table: false,
      });

      // The app role may change rows, not the schema.
      await expect(
        app.query(`alter table ${schema.name}.things add column extra text`),
      ).rejects.toThrow(/must be owner/);

      await schema.truncate('things');
      const empty = await app.query(`select 1 from ${schema.name}.things`);
      expect(empty.rows).toEqual([]);
      await expect(schema.truncate('things; drop')).rejects.toThrow(
        /lower-case letters and underscores/,
      );
    } finally {
      await app.end();
    }

    const name = schema.name;
    await schema.drop();

    const check = new Client({ connectionString: adminUrl });
    await check.connect();
    try {
      const left = await check.query(
        `select (select count(*) from pg_namespace where nspname = $1)::int as schemas,
                (select count(*) from pg_roles where rolname like $2)::int as roles`,
        [name, `${name}%`],
      );
      expect(left.rows[0]).toEqual({ schemas: 0, roles: 0 });
    } finally {
      await check.end();
    }
  }, 60_000);
});
