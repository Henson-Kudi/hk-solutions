import type { ByteStream } from './ports';

/**
 * Small helpers over byte streams.
 *
 * They are written with plain iterator calls, not `for await` or
 * `async function*`. This code also runs on Hermes (React Native), and
 * plain calls are the form every runtime it targets is certain to accept.
 */

/** A stream that yields the given chunks, then ends. */
export const streamOf = (...chunks: Uint8Array[]): ByteStream => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = chunks[index];
        if (chunk === undefined) {
          return { done: true, value: undefined };
        }
        index += 1;
        return { done: false, value: chunk };
      },
    };
  },
});

/** Joins chunks into one array. */
export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/**
 * Reads a whole stream into memory. For tests and small files only: the
 * point of a stream is not to do this with large ones.
 */
export const collectBytes = async (stream: ByteStream): Promise<Uint8Array> => {
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
  }
  return concatBytes(chunks);
};
