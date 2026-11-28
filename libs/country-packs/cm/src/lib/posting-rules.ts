import { standardPostingRules } from '@hk/country-packs/kernel';

/**
 * The posting rules a new Cameroon business starts with: the standard set,
 * with tax posted when an advance is received (Code Général des Impôts 2026,
 * art. 134).
 */
export const CM_POSTING_RULES = standardPostingRules({ taxOnAdvances: true });
