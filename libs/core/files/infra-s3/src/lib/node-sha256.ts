import { createHash } from 'node:crypto';
import type { CreateStreamHasher } from '@hk/core/files/application';

/** SHA-256 from Node's crypto, fed a piece at a time: the hasher the server gives the file service. */
export const createNodeSha256: CreateStreamHasher = () => {
  const hash = createHash('sha256');
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digest: () => hash.digest('hex'),
  };
};
