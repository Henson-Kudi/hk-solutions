import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/** Languages the platform supports. English and French are required; Arabic arrives with the UAE work. */
export const LOCALES = ['en', 'fr', 'ar'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * A piece of business data stored in every required language, such as an
 * account name or a tax label. Interface text does not use this: it lives in
 * i18n catalogues.
 */
export interface LocalizedText {
  readonly en: string;
  readonly fr: string;
  readonly ar?: string;
}

const RTL_LOCALES: readonly Locale[] = ['ar'];

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

/** True when the language is written right to left. */
export const isRtl = (locale: Locale): boolean => RTL_LOCALES.includes(locale);

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const invalid = (): DomainError =>
  new DomainError(
    'LOCALIZED_TEXT_INVALID',
    'Localized text needs non-empty "en" and "fr" strings, and "ar" must be a non-empty string when present.',
  );

/** Validates an unknown boundary value. Text is trimmed; unknown keys are dropped. */
export const parseLocalizedText = (input: unknown): Result<LocalizedText> => {
  if (typeof input !== 'object' || input === null) {
    return err(invalid());
  }
  const { en, fr, ar } = input as Partial<Record<Locale, unknown>>;
  if (!isFilled(en) || !isFilled(fr)) {
    return err(invalid());
  }
  if (ar === undefined) {
    return ok({ en: en.trim(), fr: fr.trim() });
  }
  if (!isFilled(ar)) {
    return err(invalid());
  }
  return ok({ en: en.trim(), fr: fr.trim(), ar: ar.trim() });
};

/** Throws a DomainError when a required language is missing. */
export const localizedText = (
  en: string,
  fr: string,
  ar?: string,
): LocalizedText => {
  const parsed = parseLocalizedText(
    ar === undefined ? { en, fr } : { en, fr, ar },
  );
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
};

/** The text in the requested language, or in English when that language is missing. */
export const localize = (text: LocalizedText, locale: Locale): string =>
  text[locale] ?? text[DEFAULT_LOCALE];
