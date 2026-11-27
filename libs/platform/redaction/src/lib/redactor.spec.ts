import {
  REDACTED,
  TRUNCATED,
  createRedactor,
  defaultRedactor,
} from './redactor';

const { redact, redactText } = defaultRedactor;

describe('redaction by key', () => {
  it.each([
    'password',
    'Password',
    'user_password',
    'passwordHash',
    'accessToken',
    'access_token',
    'refresh-token',
    'idToken',
    'apiKey',
    'X-Api-Key',
    'clientSecret',
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'otp',
    'loginOtp',
    'pin',
    'devicePin',
    'verificationCode',
    'phone',
    'customerPhone',
    'phone_number',
    'msisdn',
    'mobile',
    'whatsapp',
    'idNumber',
    'national_id',
    'passportNumber',
    'emiratesId',
    'cardNumber',
    'cvv',
    'iban',
    'body',
    'rawBody',
    'requestBody',
    'privateKey',
    'credentials',
  ])('replaces the value under "%s"', (key) => {
    expect(redact({ [key]: 'sensitive-value-123' })).toEqual({
      [key]: REDACTED,
    });
    expect(redact({ outer: { inner: [{ [key]: { nested: 'x' } }] } })).toEqual({
      outer: { inner: [{ [key]: REDACTED }] },
    });
  });

  it.each([
    'tokenCount',
    'passwordless',
    'phoneVerified',
    'pinned',
    'bodyLength',
    'secretSanta',
    'tokenId',
    'amount',
    'invoiceId',
    'status',
  ])('leaves the value under "%s" alone', (key) => {
    expect(redact({ [key]: 'ordinary' })).toEqual({ [key]: 'ordinary' });
  });

  it('keeps null and undefined, so "no value" stays visible', () => {
    expect(redact({ otp: null, pin: undefined, phone: '' })).toEqual({
      otp: null,
      pin: undefined,
      phone: REDACTED,
    });
  });

  it('replaces non-string values too', () => {
    expect(redact({ pin: 1234, body: { a: 1 }, otp: ['1', '2'] })).toEqual({
      pin: REDACTED,
      body: REDACTED,
      otp: REDACTED,
    });
  });

  it('accepts extra keys, matched the same way', () => {
    const custom = createRedactor({ keys: ['NIU', 'tax_file'] });
    expect(
      custom.redact({
        niu: 'M0123',
        customerNiu: 'M0456',
        taxFile: 'x',
        name: 'A',
      }),
    ).toEqual({
      niu: REDACTED,
      customerNiu: REDACTED,
      taxFile: REDACTED,
      name: 'A',
    });
  });
});

describe('redaction by shape', () => {
  const jwt =
    'eyJhbGciOiJFUzI1NiIsImtpZCI6ImdhdGV3YXktMSJ9.eyJpc3MiOiJnYXRld2F5Iiwic3ViIjoidTEifQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';

  it('replaces a JWT wherever it appears', () => {
    expect(redactText(`verification failed for ${jwt} at core`)).toBe(
      `verification failed for ${REDACTED} at core`,
    );
    expect(redact({ note: jwt })).toEqual({ note: REDACTED });
  });

  it('replaces the credential of a Bearer or Basic header, keeping the scheme', () => {
    expect(redactText('Authorization: Bearer abc123def456ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactText('sent basic dXNlcjpwYXNzd29yZA==')).toBe(
      `sent basic ${REDACTED}`,
    );
  });

  it.each([
    [
      'postgres://sales:hunter2@db.internal:5432/hk',
      `postgres://sales:${REDACTED}@db.internal:5432/hk`,
    ],
    ['redis://:s3cr3t@cache:6379', `redis://:${REDACTED}@cache:6379`],
    [
      'https://user:p%40ss@api.example.com/v1',
      `https://user:${REDACTED}@api.example.com/v1`,
    ],
  ])('replaces the password in %s', (url, expected) => {
    expect(redactText(`connect failed for ${url}`)).toBe(
      `connect failed for ${expected}`,
    );
  });

  it('leaves a URL without credentials alone', () => {
    const text = 'GET https://api.example.com:8443/v1/items?page=2 took 30ms';
    expect(redactText(text)).toBe(text);
  });

  it.each([
    '+237677123456',
    '+237 6 77 12 34 56',
    '+971 50 123 4567',
    '+971-50-123-4567',
    '+1 (415) 555-0132',
  ])('replaces the international phone number %s', (phone) => {
    expect(redactText(`otp sent to ${phone} ok`)).toBe(
      `otp sent to ${REDACTED} ok`,
    );
  });

  it.each([
    '4111111111111111',
    '4111 1111 1111 1111',
    '5500-0000-0000-0004',
    '340000000000009',
  ])('replaces the card number %s', (card) => {
    expect(redactText(`charge ${card} declined`)).toBe(
      `charge ${REDACTED} declined`,
    );
  });

  it.each([
    ['an amount', '1500000.0000'],
    ['a large whole amount', '12500000'],
    ['a 16-digit number that fails the Luhn check', '4111111111111112'],
    ['a UUID', '018f2c3a-7b1e-7000-8000-00000000000a'],
    ['a millisecond timestamp', '1764237600000'],
    ['an ISO date', '2026-11-27T10:00:00.000Z'],
    ['a document number', 'INV-YDE-2026-00042'],
    ['a local phone-like number without +', '677123456'],
    ['an error code', 'MONEY_CURRENCY_MISMATCH'],
  ])('leaves %s alone', (_label, value) => {
    expect(redactText(value)).toBe(value);
    expect(redact({ value })).toEqual({ value });
  });

  it('accepts extra patterns, such as a national ID format', () => {
    const custom = createRedactor({
      patterns: [{ name: 'emirates-id', pattern: /\b784-\d{4}-\d{7}-\d\b/g }],
    });
    expect(custom.redactText('customer 784-1990-1234567-1 verified')).toBe(
      `customer ${REDACTED} verified`,
    );
    expect(redactText('customer 784-1990-1234567-1 verified')).toContain(
      '784-1990',
    );
  });

  it('refuses a pattern without the global flag', () => {
    expect(() =>
      createRedactor({ patterns: [{ name: 'bad', pattern: /x/ }] }),
    ).toThrow(/global flag/);
  });
});

describe('redacting structures', () => {
  it('never changes its input', () => {
    const input = { user: { password: 'p', notes: ['call +237677123456'] } };
    const copy = JSON.parse(JSON.stringify(input));
    const output = redact(input);
    expect(input).toEqual(copy);
    expect(output).toEqual({
      user: { password: REDACTED, notes: [`call ${REDACTED}`] },
    });
    expect(output.user).not.toBe(input.user);
  });

  it('passes numbers, booleans, null, undefined and dates through', () => {
    const date = new Date('2026-11-27T10:00:00.000Z');
    expect(redact({ a: 1, b: true, c: null, d: undefined, e: date })).toEqual({
      a: 1,
      b: true,
      c: null,
      d: undefined,
      e: date,
    });
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });

  it('redacts an Error: message, stack, cause and its own fields', () => {
    const cause = new Error('auth failed for postgres://sales:hunter2@db/hk');
    const error = Object.assign(new Error('query failed', { cause }), {
      code: 'DB_DOWN',
      token: 'abc',
    });
    const redacted = redact(error) as unknown as Record<string, unknown>;
    expect(redacted).toMatchObject({
      name: 'Error',
      message: 'query failed',
      code: 'DB_DOWN',
      token: REDACTED,
      cause: {
        name: 'Error',
        message: `auth failed for postgres://sales:${REDACTED}@db/hk`,
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('redacts what a class instance serialises to', () => {
    class Customer {
      constructor(
        readonly name: string,
        readonly phone: string,
      ) {}
      toJSON() {
        return { name: this.name, phone: this.phone };
      }
    }
    expect(redact({ customer: new Customer('Ada', '677123456') })).toEqual({
      customer: { name: 'Ada', phone: REDACTED },
    });
  });

  it('survives a circular reference', () => {
    const node: Record<string, unknown> = { name: 'a', password: 'p' };
    node['self'] = node;
    expect(redact(node)).toEqual({
      name: 'a',
      password: REDACTED,
      self: TRUNCATED,
    });
  });

  it('keeps a value that appears twice without being circular', () => {
    const shared = { note: 'ok' };
    expect(redact({ first: shared, second: shared })).toEqual({
      first: { note: 'ok' },
      second: { note: 'ok' },
    });
  });

  it('stops at the depth limit', () => {
    let deep: Record<string, unknown> = { password: 'bottom' };
    for (let level = 0; level < 12; level += 1) {
      deep = { next: deep };
    }
    const text = JSON.stringify(redact(deep));
    expect(text).toContain(TRUNCATED);
    expect(text).not.toContain('bottom');
    expect(
      JSON.stringify(
        createRedactor({ maxDepth: 2 }).redact({ a: { b: { c: 1 } } }),
      ),
    ).toBe(`{"a":{"b":"${TRUNCATED}"}}`);
  });
});
