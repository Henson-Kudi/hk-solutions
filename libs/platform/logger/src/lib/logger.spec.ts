import { DomainError } from '@hk/platform/universal';
import { addLogContext, getLogContext, runWithLogContext } from './log-context';
import { REDACTED, SENSITIVE_KEYS, serializeError } from './logger';
import { createMemoryLogger } from './memory-logger';

describe('createLogger', () => {
  it('writes one JSON line with level, time, service and message', () => {
    const { logger, entries } = createMemoryLogger({
      service: 'sales',
      version: '1.2.3',
      environment: 'test',
    });
    logger.info('invoice issued', { invoiceId: 'inv-1', lines: 3 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      level: 'info',
      time: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      service: 'sales',
      version: '1.2.3',
      environment: 'test',
      message: 'invoice issued',
      invoiceId: 'inv-1',
      lines: 3,
    });
  });

  it('has a method per level and respects the configured level', () => {
    const { logger, entries } = createMemoryLogger({ level: 'warn' });
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(entries.map((entry) => entry.level)).toEqual([
      'warn',
      'error',
      'fatal',
    ]);
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
    expect(logger.isLevelEnabled('silent')).toBe(false);
  });

  it('writes nothing at level silent', () => {
    const { logger, entries } = createMemoryLogger({ level: 'silent' });
    logger.fatal('f');
    expect(entries).toHaveLength(0);
  });

  it('adds child fields to every line of the child only', () => {
    const { logger, entries } = createMemoryLogger();
    const child = logger.child({ component: 'posting-engine' });
    child.info('from child');
    logger.info('from parent');
    expect(entries[0]).toMatchObject({ component: 'posting-engine' });
    expect(entries[1]).not.toHaveProperty('component');
  });

  it('serialises an Error under any key, with its cause', () => {
    const { logger, entries } = createMemoryLogger();
    const cause = new Error('socket closed');
    logger.error('payment call failed', {
      err: new Error('request failed', { cause }),
    });
    expect(entries[0]?.['err']).toMatchObject({
      name: 'Error',
      message: 'request failed',
      stack: expect.stringContaining('request failed'),
      cause: { name: 'Error', message: 'socket closed' },
    });
  });

  it('keeps the code, kind and details of a DomainError', () => {
    const error = new DomainError('INVOICE_ALREADY_ISSUED', 'Issued.', {
      kind: 'conflict',
      details: { status: 'ISSUED' },
    });
    expect(serializeError(error)).toMatchObject({
      name: 'DomainError',
      code: 'INVOICE_ALREADY_ISSUED',
      kind: 'conflict',
      details: { status: 'ISSUED' },
    });
  });

  it('stops following a cause chain after three levels', () => {
    let error = new Error('level 0');
    for (let level = 1; level <= 6; level += 1) {
      error = new Error(`level ${level}`, { cause: error });
    }
    expect(JSON.stringify(serializeError(error))).not.toContain('level 2');
    expect(JSON.stringify(serializeError(error))).toContain('level 3');
  });
});

describe('redaction', () => {
  it.each(SENSITIVE_KEYS)('never writes the value of "%s"', (key) => {
    const { logger, entries, text } = createMemoryLogger();
    const secret = `s3cr3t-${key}`;
    logger.info('login attempt', {
      [key]: secret,
      user: { [key]: secret },
      request: { headers: { [key]: secret } },
    });
    expect(text()).not.toContain(secret);
    expect(entries[0]?.[key]).toBe(REDACTED);
    expect(entries[0]?.['user']).toEqual({ [key]: REDACTED });
    expect(entries[0]?.['request']).toEqual({ headers: { [key]: REDACTED } });
  });

  it('redacts sensitive keys in child fields and in the log context', () => {
    const { logger, text } = createMemoryLogger();
    runWithLogContext({ token: 'ctx-secret' }, () => {
      logger.child({ apiKey: 'child-secret' }).info('working');
    });
    expect(text()).not.toContain('ctx-secret');
    expect(text()).not.toContain('child-secret');
  });

  it('leaves other fields alone', () => {
    const { logger, entries } = createMemoryLogger();
    logger.info('ok', { tokenCount: 3, passwordless: true });
    expect(entries[0]).toMatchObject({ tokenCount: 3, passwordless: true });
  });

  it('runs the redact hook over fields, child fields and context', () => {
    const { logger, entries, text } = createMemoryLogger({
      redact: (fields) =>
        Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            typeof value === 'string'
              ? value.replace(/\d{9}/g, '#########')
              : value,
          ]),
        ),
    });
    runWithLogContext({ caller: 'phone 677123456' }, () => {
      logger.child({ note: 'id 123456789' }).info('sent', { to: '699000111' });
    });
    expect(text()).not.toMatch(/\d{9}/);
    expect(entries[0]).toMatchObject({
      to: '#########',
      note: 'id #########',
      caller: 'phone #########',
    });
  });
});

describe('log context', () => {
  it('adds its fields to every line written inside it, across awaits', async () => {
    const { logger, entries } = createMemoryLogger();
    await runWithLogContext({ requestId: 'req-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      logger.info('inside');
    });
    logger.info('outside');
    expect(entries[0]).toMatchObject({ requestId: 'req-1' });
    expect(entries[1]).not.toHaveProperty('requestId');
  });

  it('keeps two concurrent contexts apart', async () => {
    const { logger, entries } = createMemoryLogger();
    const work = (requestId: string, delay: number) =>
      runWithLogContext({ requestId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        logger.info('done', { expected: requestId });
      });
    await Promise.all([work('a', 5), work('b', 1)]);
    for (const entry of entries) {
      expect(entry['requestId']).toBe(entry['expected']);
    }
  });

  it('nests, with the inner value winning', () => {
    runWithLogContext({ requestId: 'outer', tenant: 't1' }, () => {
      runWithLogContext({ requestId: 'inner' }, () => {
        expect(getLogContext()).toEqual({ requestId: 'inner', tenant: 't1' });
      });
      expect(getLogContext()).toEqual({ requestId: 'outer', tenant: 't1' });
    });
  });

  it('accepts fields learned part-way through', () => {
    const { logger, entries } = createMemoryLogger();
    runWithLogContext({ requestId: 'req-1' }, () => {
      addLogContext({ businessId: 'biz-9' });
      logger.info('with business');
    });
    expect(entries[0]).toMatchObject({
      requestId: 'req-1',
      businessId: 'biz-9',
    });
  });

  it('is undefined outside a context, where adding does nothing', () => {
    expect(getLogContext()).toBeUndefined();
    expect(() => addLogContext({ x: 1 })).not.toThrow();
    expect(getLogContext()).toBeUndefined();
  });

  it('lets a field on the line win over the context', () => {
    const { logger, entries } = createMemoryLogger();
    runWithLogContext({ step: 'context' }, () => {
      logger.info('override', { step: 'line' });
    });
    expect(entries[0]?.['step']).toBe('line');
  });
});
