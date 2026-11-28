import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * A software authenticator, FOR TESTS ONLY.
 *
 * It does what a phone or a security key does in a WebAuthn ceremony: it
 * makes a real ES256 key pair, builds the binary structures the standard
 * defines, and signs with the private key. So the real verifier is tested
 * against real signatures, not against a stand-in.
 *
 * Its fields are public so a test can make it lie: claim another origin,
 * skip user verification, report a stale count.
 *
 * It is not exported from the lib's index and must never be used outside
 * tests: a server has no business holding passkey private keys.
 */

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

const sha256 = (data: Uint8Array | string): Buffer =>
  createHash('sha256').update(data).digest();

/** CBOR for a byte string. */
const cborBytes = (bytes: Uint8Array): Buffer => {
  const length = bytes.length;
  const head =
    length < 24
      ? Buffer.from([0x40 + length])
      : length < 256
        ? Buffer.from([0x58, length])
        : Buffer.from([0x59, length >> 8, length & 0xff]);
  return Buffer.concat([head, bytes]);
};

/** CBOR for a short text string. */
const cborText = (text: string): Buffer => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length >= 24) throw new Error('text too long for this helper');
  return Buffer.concat([Buffer.from([0x60 + bytes.length]), bytes]);
};

// Bits of the flags byte in authenticator data.
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

export interface CeremonyOptions {
  challenge: string;
  /** Present in registration options. */
  user?: { id: string };
}

export class VirtualAuthenticator {
  readonly credentialId: Buffer = randomBytes(32);
  privateKey: KeyObject;
  readonly publicKey: KeyObject;

  /** The origin the "browser" reports. */
  origin: string;
  /** The site the authenticator believes it is talking to. */
  rpId: string;
  userPresent = true;
  userVerified = true;
  multiDevice = true;
  backedUp = true;
  /** The use count reported next. Stays 0 unless `counts` is true. */
  signCount = 0;
  counts = false;
  /** The user handle stored at registration, as the device keeps it. */
  userHandle: string | null = null;

  constructor(site: { origin: string; rpId: string }) {
    this.origin = site.origin;
    this.rpId = site.rpId;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private flags(extra = 0): number {
    return (
      (this.userPresent ? FLAG_USER_PRESENT : 0) |
      (this.userVerified ? FLAG_USER_VERIFIED : 0) |
      (this.multiDevice ? FLAG_BACKUP_ELIGIBLE : 0) |
      (this.multiDevice && this.backedUp ? FLAG_BACKED_UP : 0) |
      extra
    );
  }

  private counter(): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(this.signCount);
    return bytes;
  }

  /** The public key in COSE form: an EC2 key on P-256 for ES256. */
  private coseKey(): Buffer {
    const jwk = this.publicKey.export({ format: 'jwk' });
    return Buffer.concat([
      Buffer.from([0xa5]), // a map of five entries
      Buffer.from([0x01, 0x02]), // kty: EC2
      Buffer.from([0x03, 0x26]), // alg: -7 (ES256)
      Buffer.from([0x20, 0x01]), // crv: P-256
      Buffer.from([0x21]),
      cborBytes(Buffer.from(jwk.x as string, 'base64url')),
      Buffer.from([0x22]),
      cborBytes(Buffer.from(jwk.y as string, 'base64url')),
    ]);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
      'utf8',
    );
  }

  /** What navigator.credentials.create() would return, as JSON. */
  register(options: CeremonyOptions): Record<string, unknown> {
    this.userHandle = options.user?.id ?? null;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags(FLAG_ATTESTED_CREDENTIAL)]),
      this.counter(),
      Buffer.alloc(16), // AAGUID: all zero, "no particular make"
      length,
      this.credentialId,
      this.coseKey(),
    ]);
    // { "fmt": "none", "attStmt": {}, "authData": <bytes> }
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      cborBytes(authData),
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(
          this.clientData('webauthn.create', options.challenge),
        ),
        attestationObject: b64(attestationObject),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** What navigator.credentials.get() would return, as JSON. */
  authenticate(options: CeremonyOptions): {
    id: string;
    rawId: string;
    type: string;
    clientExtensionResults: Record<string, never>;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
  } {
    if (this.counts) this.signCount += 1;
    const authenticatorData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags()]),
      this.counter(),
    ]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    // The signature covers the authenticator data and the hash of the
    // client data, as the standard says.
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
        ...(this.userHandle === null ? {} : { userHandle: this.userHandle }),
      },
    };
  }
}
