import { DomainError, err, ok, type Result } from '@hk/platform/universal';
import { IDENTITY_ERRORS } from './errors';

/**
 * What a password must be.
 *
 * The rule itself (length, upper case, lower case, a digit) is kept from
 * BizTrack so that what users learned there still holds. Two things are added
 * because they cost users nothing and stop the worst choices: a password may
 * not be the account's own name, phone number or email, and may not be one
 * of the handful everybody tries first.
 */
export const PASSWORD_RULES = {
  minLength: 8,
  /** A ceiling so a huge input cannot be used to keep the hasher busy. */
  maxLength: 128,
} as const;

export const PASSWORD_PROBLEMS = [
  'too_short',
  'too_long',
  'no_uppercase',
  'no_lowercase',
  'no_digit',
  'too_common',
  'contains_identity',
] as const;

export type PasswordProblem = (typeof PASSWORD_PROBLEMS)[number];

/** Passwords that meet the letter rules and are still the first ones guessed. */
const TOO_COMMON = new Set([
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'qwerty123',
  'qwertyuiop1',
  'azerty123',
  'abcd1234',
  'abc12345',
  'welcome1',
  'welcome123',
  'admin123',
  'letmein1',
  'iloveyou1',
  'changeme1',
  'motdepasse1',
  'cameroun1',
  'cameroon1',
  'bonjour123',
]);

export interface PasswordContext {
  /** Things the password must not be built from: the name, phone and email. */
  readonly identity?: readonly (string | null | undefined)[];
}

const letters = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Every rule a password breaks. Empty means it is acceptable. */
export const findPasswordProblems = (
  password: unknown,
  context: PasswordContext = {},
): PasswordProblem[] => {
  if (typeof password !== 'string') return ['too_short'];
  const problems: PasswordProblem[] = [];
  // Counted in characters as a person sees them, not in storage units.
  const length = Array.from(password).length;
  if (length < PASSWORD_RULES.minLength) problems.push('too_short');
  if (length > PASSWORD_RULES.maxLength) problems.push('too_long');
  if (!/\p{Lu}/u.test(password)) problems.push('no_uppercase');
  if (!/\p{Ll}/u.test(password)) problems.push('no_lowercase');
  if (!/\p{Nd}/u.test(password)) problems.push('no_digit');
  if (TOO_COMMON.has(password.toLowerCase())) problems.push('too_common');

  const flat = letters(password);
  for (const part of context.identity ?? []) {
    const own = letters(part ?? '');
    // Short fragments ("li", "42") are in many passwords by chance.
    if (own.length >= 5 && flat.includes(own)) {
      problems.push('contains_identity');
      break;
    }
  }
  return problems;
};

/**
 * Checks a new password. The error lists which rules were broken, by name,
 * so a form can say exactly what to fix. It never contains the password.
 */
export const checkPassword = (
  password: unknown,
  context: PasswordContext = {},
): Result<string> => {
  const problems = findPasswordProblems(password, context);
  if (problems.length > 0) {
    return err(
      new DomainError(
        IDENTITY_ERRORS.PASSWORD_WEAK,
        'The password does not meet the rules.',
        { details: { problems: problems.join(',') } },
      ),
    );
  }
  return ok(password as string);
};
