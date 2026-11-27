import { z } from 'zod';
import { env, serviceEnv } from './env';
import { ConfigError, loadConfig } from './load-config';

const issuesOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('loadConfig did not throw');
};

describe('loadConfig', () => {
  const schema = z.object({
    ...serviceEnv,
    DATABASE_URL: env.url(['postgres:', 'postgresql:']),
    SERVICES: env.list().default([]),
    SHUTDOWN_TIMEOUT: env.duration().default(10_000),
    FEATURE_X: env.boolean().default(false),
    API_KEY: env.text(),
  });

  const valid = {
    DATABASE_URL: 'postgres://app:pw@localhost:54320/hk',
    API_KEY: 'k-123',
  };

  it('parses strings into typed values and applies defaults', () => {
    const config = loadConfig(schema, {
      ...valid,
      PORT: '8080',
      NODE_ENV: 'production',
      SERVICES: 'core, sales,,',
      SHUTDOWN_TIMEOUT: '30s',
      FEATURE_X: '1',
    });
    expect(config).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      PORT: 8080,
      DATABASE_URL: 'postgres://app:pw@localhost:54320/hk',
      SERVICES: ['core', 'sales'],
      SHUTDOWN_TIMEOUT: 30_000,
      FEATURE_X: true,
      API_KEY: 'k-123',
    });
  });

  it('treats an empty variable as not set', () => {
    const config = loadConfig(schema, { ...valid, PORT: '', LOG_LEVEL: '' });
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('ignores variables the schema does not name', () => {
    const config = loadConfig(schema, { ...valid, PATH: '/usr/bin' });
    expect(config).not.toHaveProperty('PATH');
  });

  it('freezes the result, including nested values', () => {
    const config = loadConfig(schema, { ...valid, SERVICES: 'core' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.SERVICES)).toBe(true);
  });

  it('reports every bad variable at once', () => {
    const issues = issuesOf(() =>
      loadConfig(schema, { PORT: '70000', NODE_ENV: 'staging' }),
    );
    expect(issues.map((issue) => issue.key).sort()).toEqual([
      'API_KEY',
      'DATABASE_URL',
      'NODE_ENV',
      'PORT',
    ]);
  });

  it('never puts a value in the error', () => {
    const secret = 'postgres-but-not-a-url-s3cr3t';
    let message = '';
    try {
      loadConfig(schema, { ...valid, DATABASE_URL: secret, PORT: 'abc123' });
    } catch (error) {
      message = `${(error as Error).message} ${JSON.stringify(error)}`;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('abc123');
  });

  it('reads process.env by default', () => {
    const only = z.object({ HK_CONFIG_SPEC_VALUE: env.integer() });
    process.env['HK_CONFIG_SPEC_VALUE'] = '42';
    try {
      expect(loadConfig(only).HK_CONFIG_SPEC_VALUE).toBe(42);
    } finally {
      delete process.env['HK_CONFIG_SPEC_VALUE'];
    }
  });
});

describe('env helpers', () => {
  const parse = <T>(schema: z.ZodType<T, string>, value: string) =>
    schema.safeParse(value);

  it('integer is strict about format and range', () => {
    expect(parse(env.integer(), '5432').data).toBe(5432);
    expect(parse(env.integer(), '-7').data).toBe(-7);
    for (const bad of ['5.5', '1e3', ' 5', '5 ', 'abc', '0x10', '']) {
      expect(parse(env.integer(), bad).success).toBe(false);
    }
    expect(parse(env.integer({ min: 1, max: 10 }), '0').success).toBe(false);
    expect(parse(env.integer({ min: 1, max: 10 }), '11').success).toBe(false);
    expect(parse(env.integer(), '99999999999999999999').success).toBe(false);
  });

  it('port accepts 1 to 65535', () => {
    expect(parse(env.port(), '1').data).toBe(1);
    expect(parse(env.port(), '65535').data).toBe(65_535);
    expect(parse(env.port(), '0').success).toBe(false);
    expect(parse(env.port(), '65536').success).toBe(false);
  });

  it('boolean accepts four spellings only', () => {
    expect(parse(env.boolean(), 'true').data).toBe(true);
    expect(parse(env.boolean(), '1').data).toBe(true);
    expect(parse(env.boolean(), 'false').data).toBe(false);
    expect(parse(env.boolean(), '0').data).toBe(false);
    for (const bad of ['yes', 'TRUE', 'on', '']) {
      expect(parse(env.boolean(), bad).success).toBe(false);
    }
  });

  it('url checks the scheme when asked to', () => {
    expect(parse(env.url(), 'https://example.com/x').success).toBe(true);
    expect(parse(env.url(), 'not a url').success).toBe(false);
    const redis = env.url(['redis:', 'rediss:']);
    expect(parse(redis, 'redis://localhost:63790').success).toBe(true);
    expect(parse(redis, 'http://localhost:63790').success).toBe(false);
  });

  it('duration converts to milliseconds', () => {
    expect(parse(env.duration(), '250ms').data).toBe(250);
    expect(parse(env.duration(), '30s').data).toBe(30_000);
    expect(parse(env.duration(), '5m').data).toBe(300_000);
    expect(parse(env.duration(), '1h').data).toBe(3_600_000);
    expect(parse(env.duration(), '7d').data).toBe(604_800_000);
    for (const bad of ['30', '30 s', '1.5h', 's', '-5s']) {
      expect(parse(env.duration(), bad).success).toBe(false);
    }
  });

  it('text rejects an empty string', () => {
    expect(parse(env.text(), 'x').success).toBe(true);
    expect(parse(env.text(), '').success).toBe(false);
  });
});
