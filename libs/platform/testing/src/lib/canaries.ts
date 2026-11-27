/**
 * Redaction canaries.
 *
 * A canary is a made-up secret with a value nothing else would ever contain.
 * A test pushes the canaries through a place where data leaves the service
 * (a log line, an error response) and then searches the output for them.
 * Finding one means that sink leaks.
 *
 *   logger.info('something happened', canaryFields());
 *   expect(findLeaks(memory.text())).toEqual([]);
 *
 * Use them in any lib that writes logs or builds responses.
 */

/*
 * Every value below is invented. They look like secrets on purpose, so the
 * secret scanner in CI flags them: each flagged line carries the marker
 * "gitleaks:allow". Keep the marker on the line if you edit one, and never
 * put a real value in this file.
 */

/** A signed-looking token. Three base64url parts, like a real JWT. */
const JWT =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImNhbmFyeSJ9.eyJzdWIiOiJjYW5hcnktdXNlci03NzMxIn0.Y2FuYXJ5LXNpZ25hdHVyZS03NzMx'; // gitleaks:allow

/** Every canary, by the kind of secret it stands for. The values are fake. */
export const CANARIES = {
  jwt: JWT,
  password: 'canary-Passw0rd-7731', // gitleaks:allow
  otp: '773155',
  /** In international format, so it is recognisable anywhere in a string. */
  phoneInternational: '+237677007731',
  /** In local format, which only its key can identify. */
  phoneLocal: '677117731',
  idNumber: 'CANARY-ID-7731-CM',
  /** A test card number that passes the Luhn check. */
  card: '4111111111111111',
  connectionPassword: 'canary-db-pass-7731', // gitleaks:allow
  requestBody: 'canary-request-body-7731',
  apiKey: 'canary-api-key-7731', // gitleaks:allow
} as const;

export type CanaryName = keyof typeof CANARIES;

/**
 * The canaries as log fields, each placed the way such a value shows up in
 * real code: under a telling key, nested, inside free text, and inside an
 * Error.
 */
export const canaryFields = (): Record<string, unknown> => ({
  password: CANARIES.password,
  otp: CANARIES.otp,
  headers: {
    authorization: `Bearer ${CANARIES.jwt}`,
    'x-api-key': CANARIES.apiKey,
  },
  customer: {
    name: 'Canary Customer',
    phone: CANARIES.phoneLocal,
    idNumber: CANARIES.idNumber,
  },
  body: { note: CANARIES.requestBody },
  note: canaryText(),
  err: new Error(canaryText()),
});

/**
 * The canaries that can be recognised by shape, inside one sentence. This is
 * the hard case: nothing but the value itself says it is sensitive.
 */
export const canaryText = (): string =>
  `call ${CANARIES.phoneInternational} about card ${CANARIES.card}; ` +
  `connect failed for postgres://app:${CANARIES.connectionPassword}@db.internal:5432/hk ` +
  `with token ${CANARIES.jwt}`;

/** The canaries canaryText() contains. */
export const TEXT_CANARIES: readonly CanaryName[] = [
  'phoneInternational',
  'card',
  'connectionPassword',
  'jwt',
];

/** The canaries as a flat object of strings, the shape of DomainError details. */
export const canaryDetails = (): Record<string, string> => ({
  password: CANARIES.password,
  otp: CANARIES.otp,
  phone: CANARIES.phoneLocal,
  idNumber: CANARIES.idNumber,
  apiKey: CANARIES.apiKey,
  body: CANARIES.requestBody,
  note: canaryText(),
});

/**
 * The names of the canaries that appear in `output`. An empty list means the
 * sink that produced the output did not leak.
 */
export const findLeaks = (output: string): CanaryName[] =>
  (Object.keys(CANARIES) as CanaryName[]).filter((name) =>
    output.includes(CANARIES[name]),
  );
