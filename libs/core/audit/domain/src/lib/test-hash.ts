import type { Sha256 } from './chain';

/**
 * A stand-in for SHA-256, FOR TESTS ONLY.
 *
 * Pure code cannot import a real SHA-256 (Node's is not on a phone, and the
 * browser's is asynchronous), so tests of the chain logic use this instead.
 * It is deterministic and spreads its input over 64 hex characters, which is
 * all those tests need. It is NOT secure: anyone can build two texts with the
 * same result. Production code is given a real SHA-256, such as nodeSha256
 * from @hk/core/audit/infra-pg.
 */
export const insecureTestHash: Sha256 = (text) => {
  let out = '';
  for (let seed = 1; seed <= 8; seed += 1) {
    // FNV-1a, 32 bits, started from a different value for each block.
    let hash = (0x811c9dc5 ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
};
