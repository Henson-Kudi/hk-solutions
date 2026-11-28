import { createHash } from 'node:crypto';
import type { Sha256 } from '@hk/core/audit/domain';

/** SHA-256 from Node's crypto: the hash function the server gives the audit chain. */
export const nodeSha256: Sha256 = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
