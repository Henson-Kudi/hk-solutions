import { AsyncLocalStorage } from 'node:async_hooks';

/** Structured values that go with a message. Put an Error under any key, by convention `err`. */
export type LogFields = Record<string, unknown>;

const storage = new AsyncLocalStorage<LogFields>();

/**
 * Runs `action` with fields that every log line written inside it carries,
 * however deep the call goes and across awaits. The request middleware uses
 * this for the request id; a queue worker uses it for the job id.
 *
 * Nested calls add to the outer fields, and the inner value wins on a clash.
 */
export const runWithLogContext = <T>(fields: LogFields, action: () => T): T =>
  storage.run({ ...storage.getStore(), ...fields }, action);

/** The fields of the current context, or undefined outside one. */
export const getLogContext = (): LogFields | undefined => storage.getStore();

/**
 * Adds fields to the current context, for values learned part-way through,
 * such as the tenant once the token is verified. Does nothing outside a
 * context.
 */
export const addLogContext = (fields: LogFields): void => {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, fields);
  }
};
