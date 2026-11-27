import { RequestValidationError, toProblemDetails } from '@hk/platform/errors';
import { HttpClientError, createHttpClient } from '@hk/platform/http';
import { createMemoryLogger, runWithLogContext } from '@hk/platform/logger';
import type { Redactor } from '@hk/platform/redaction';
import { DomainError } from '@hk/platform/universal';
import {
  CANARIES,
  TEXT_CANARIES,
  canaryDetails,
  canaryFields,
  canaryText,
  findLeaks,
  type CanaryName,
} from './canaries';

/**
 * THE CANARY TEST (plan row 1.6: "the canary test fails on a planted leak").
 *
 * Fake secrets go into every place where data leaves a service, and none may
 * come out. The last block proves the test can fail: with redaction switched
 * off, the same canaries are found in the output.
 */

const ALL = Object.keys(CANARIES) as CanaryName[];

/** A redactor that does nothing: the planted leak. */
const noRedaction: Redactor = {
  redact: (value) => value,
  redactText: (text) => text,
};

/** An HTTP client whose server always answers with this problem body. */
const clientAnswering = (body: unknown, redactor?: Redactor) =>
  createHttpClient({
    baseUrl: 'http://core.internal',
    name: 'core-api',
    ...(redactor ? { redactor } : {}),
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      }),
  });

const remoteProblem = () => ({
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  code: 'CONTACT_CONFLICT',
  detail: canaryText(),
  details: canaryDetails(),
});

const callAndCatch = async (redactor?: Redactor): Promise<HttpClientError> => {
  try {
    await clientAnswering(remoteProblem(), redactor).post('/contacts', {
      body: { phone: CANARIES.phoneLocal, otp: CANARIES.otp },
      headers: { authorization: `Bearer ${CANARIES.jwt}` },
      query: { phone: CANARIES.phoneInternational },
    });
  } catch (error) {
    if (error instanceof HttpClientError) {
      return error;
    }
    throw error;
  }
  throw new Error('the call did not fail');
};

describe('the canaries themselves', () => {
  it('are all found in output that contains them', () => {
    const raw = JSON.stringify({
      ...canaryFields(),
      err: String(canaryFields()['err']),
    });
    expect(findLeaks(raw).sort()).toEqual([...ALL].sort());
  });

  it('are not found in clean output', () => {
    expect(findLeaks('{"level":"info","message":"invoice issued"}')).toEqual(
      [],
    );
  });

  it('put every shape-detectable canary in the free text', () => {
    expect(findLeaks(canaryText()).sort()).toEqual([...TEXT_CANARIES].sort());
  });
});

describe('no canary leaves through the logger', () => {
  it('in the fields of a line', () => {
    const { logger, text } = createMemoryLogger();
    logger.info('something happened', canaryFields());
    expect(findLeaks(text())).toEqual([]);
  });

  it('in an Error, under any key, or as a cause', () => {
    const { logger, text } = createMemoryLogger();
    const cause = new Error(canaryText());
    logger.error('request failed', {
      err: new Error('outer failure', { cause }),
      failure: Object.assign(new Error(canaryText()), canaryDetails()),
    });
    expect(findLeaks(text())).toEqual([]);
  });

  it('in the fields of a child logger', () => {
    const { logger, text } = createMemoryLogger();
    logger.child(canaryFields()).warn('from a child');
    expect(findLeaks(text())).toEqual([]);
  });

  it('in the log context', () => {
    const { logger, text } = createMemoryLogger();
    runWithLogContext(canaryFields(), () => {
      logger.info('inside a context');
    });
    expect(findLeaks(text())).toEqual([]);
  });

  it('at every level', () => {
    const { logger, text } = createMemoryLogger();
    for (const level of [
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ] as const) {
      logger[level]('a line', canaryFields());
    }
    expect(findLeaks(text())).toEqual([]);
  });
});

describe('no canary leaves through an error response', () => {
  it('from a business-rule error that quotes input in its message and details', () => {
    const error = new DomainError('CONTACT_INVALID', canaryText(), {
      details: canaryDetails(),
    });
    const body = JSON.stringify(
      toProblemDetails(error, { instance: '/contacts' }),
    );
    expect(findLeaks(body)).toEqual([]);
    // Still useful: the code and the shape of the response survive.
    expect(JSON.parse(body)).toMatchObject({
      status: 422,
      code: 'CONTACT_INVALID',
      details: { note: expect.any(String) },
    });
  });

  it('from a validation error whose messages quote input', () => {
    const error = new RequestValidationError([
      { path: 'phone', code: 'invalid', message: canaryText() },
    ]);
    expect(findLeaks(JSON.stringify(toProblemDetails(error)))).toEqual([]);
  });

  it('from a crash, which exposes nothing at all', () => {
    const body = JSON.stringify(toProblemDetails(new Error(canaryText())));
    expect(findLeaks(body)).toEqual([]);
  });
});

describe('no canary leaves through the HTTP client', () => {
  it('in the error it throws, or when that error is logged', async () => {
    const error = await callAndCatch();
    expect(findLeaks(JSON.stringify(error.problem))).toEqual([]);
    expect(findLeaks(`${error.message} ${error.stack}`)).toEqual([]);

    const { logger, text } = createMemoryLogger();
    logger.error('core call failed', { err: error });
    expect(findLeaks(text())).toEqual([]);
  });
});

describe('the canary test fails on a planted leak', () => {
  it('finds canaries in the log when redaction is switched off', () => {
    const { logger, text } = createMemoryLogger({ redact: false });
    logger.info('something happened', canaryFields());
    // What only a key identifies is still caught by the logger's own key
    // list. Everything recognisable only by its shape gets through.
    expect(findLeaks(text())).toEqual(
      expect.arrayContaining([...TEXT_CANARIES, 'idNumber', 'phoneLocal']),
    );
  });

  it('finds canaries in an error response built without redaction', () => {
    const error = new DomainError('CONTACT_INVALID', canaryText(), {
      details: canaryDetails(),
    });
    const body = JSON.stringify(
      toProblemDetails(error, { redactor: noRedaction }),
    );
    expect(findLeaks(body).sort()).toEqual(
      [
        ...new Set<CanaryName>([
          ...TEXT_CANARIES,
          'password',
          'otp',
          'phoneLocal',
          'idNumber',
          'apiKey',
          'requestBody',
        ]),
      ].sort(),
    );
  });

  it('finds canaries in an HTTP client error built without redaction', async () => {
    const error = await callAndCatch(noRedaction);
    expect(findLeaks(JSON.stringify(error.problem))).toEqual(
      expect.arrayContaining([...TEXT_CANARIES, 'password', 'otp']),
    );
  });
});
