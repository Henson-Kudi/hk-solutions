import { builtinModules } from 'node:module';
import nx from '@nx/eslint-plugin';
import { depConstraints } from './tools/eslint/boundaries.mjs';
import {
  COUNTRY_LITERAL_EXEMPT_FILES,
  countryLiteralSelectors,
} from './tools/eslint/country-literals.mjs';

/**
 * Every project's own eslint.config.mjs spreads this config, and ESLint
 * resolves "files" globs relative to the config file in use. A glob that names
 * a workspace path, such as the ones in PURE_FILES, would therefore match
 * nothing when a lib is linted through its own config. Blocks with such globs
 * set basePath to this folder, which anchors them here whoever loads them.
 */
const WORKSPACE_ROOT = import.meta.dirname;

const SOURCE_FILES = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.cts',
  '**/*.mts',
  '**/*.js',
  '**/*.jsx',
  '**/*.cjs',
  '**/*.mjs',
];

/**
 * Code in these folders runs on the API, in the browser, in Electron and in
 * Hermes (React Native), so it may not touch Node or any framework.
 */
const PURE_FILES = [
  'libs/**/domain/**',
  'libs/**/application/**',
  'libs/platform/universal/**',
  'libs/contracts/**',
  'libs/country-packs/**',
];

const deepImports = {
  group: ['@hk/**/src', '@hk/**/src/**'],
  message:
    "Deep import. Import from the lib's public entry point (@hk/<group>/<name>), which is its src/index.ts.",
};

const frameworkImports = {
  group: [
    '@nestjs/*',
    'drizzle-orm',
    'drizzle-orm/*',
    'drizzle-kit',
    'react',
    'react/*',
    'react-dom',
    'react-dom/*',
    'react-native',
    'react-native/*',
    'expo',
    'expo-*',
    'next',
    'next/*',
    'pg',
    'better-sqlite3',
    'ioredis',
    'bullmq',
  ],
  message:
    'Framework import in a pure lib. domain, application, universal, contracts and country-pack code is framework-free. Define a port and implement it in an adapter (infra-pg, infra-sqlite, nest, ui).',
};

const nodeBuiltinMessage =
  'Node built-in in a pure lib. This code also runs in the browser and in Hermes. Use the ids, hash and clock helpers from @hk/platform/universal.';

const nodeBuiltinImports = {
  patterns: [{ group: ['node:*'], message: nodeBuiltinMessage }],
  paths: builtinModules
    .filter((name) => !name.startsWith('_'))
    .map((name) => ({ name, message: nodeBuiltinMessage })),
};

const nodeGlobalMessage =
  'Node-only global in a pure lib. This code also runs in the browser and in Hermes, where it does not exist. Take what you need through a port.';

const nodeGlobals = ['Buffer', 'process', '__dirname', '__filename'].map(
  (name) => ({ name, message: nodeGlobalMessage }),
);

/** decimal.js is wrapped by Decimal and Money, and only that wrapper imports it. */
const decimalJsImport = {
  name: 'decimal.js',
  message:
    'Import Decimal and Money from @hk/platform/universal. Only that lib talks to decimal.js, so rounding and precision are configured in one place.',
};

const LOG_METHODS = '/^(log|info|warn|error|debug|verbose|fatal|trace)$/';
const LOGGER_NAMES = '/^(log|logger|console)$|logger$/i';
const INTERPOLATED_ARG =
  ':matches(TemplateLiteral[expressions.length>0], BinaryExpression[operator="+"]).arguments';
const logMessage =
  'Log messages are constant strings. Pass values as structured fields so redaction can see them: logger.info("invoice issued", { invoiceId }).';

/** Syntax that is banned everywhere: @Global() and interpolated log messages. */
const syntaxRestrictions = [
  {
    selector: 'Decorator > CallExpression[callee.name="Global"]',
    message:
      'Never use @Global(). Import the module where it is needed so dependencies stay visible.',
  },
  {
    selector: `CallExpression[callee.property.name=${LOG_METHODS}][callee.object.name=${LOGGER_NAMES}] > ${INTERPOLATED_ARG}`,
    message: logMessage,
  },
  {
    selector: `CallExpression[callee.property.name=${LOG_METHODS}][callee.object.property.name=${LOGGER_NAMES}] > ${INTERPOLATED_ARG}`,
    message: logMessage,
  },
];

const eslintConfig = [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/.next', '**/.expo'],
  },
  {
    files: SOURCE_FILES,
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [
            '^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$',
            // Shared Jest setup for the Hermes-compatible test target.
            '^.*/tools/jest/[\\w.-]+$',
          ],
          depConstraints,
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [deepImports], paths: [decimalJsImport] },
      ],
      'no-restricted-syntax': [
        'error',
        ...syntaxRestrictions,
        ...countryLiteralSelectors,
      ],
    },
  },
  {
    // Packs, seed data and tests may name a country. A later entry for the
    // same rule replaces the earlier one, so the other bans are repeated.
    basePath: WORKSPACE_ROOT,
    files: COUNTRY_LITERAL_EXEMPT_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...syntaxRestrictions],
    },
  },
  {
    // Developer command-line scripts print to the terminal, not to service
    // logs, so the constant-log-message rule does not apply to them.
    basePath: WORKSPACE_ROOT,
    files: ['tools/**'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Must come after the block above: a later no-restricted-imports entry
    // replaces an earlier one, so this one repeats the deep-import pattern.
    basePath: WORKSPACE_ROOT,
    files: PURE_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            deepImports,
            frameworkImports,
            ...nodeBuiltinImports.patterns,
          ],
          paths: [...nodeBuiltinImports.paths, decimalJsImport],
        },
      ],
      'no-restricted-globals': ['error', ...nodeGlobals],
    },
  },
  {
    // The one place that may import decimal.js. Everything else in the block
    // above still applies, so it is repeated here without decimalJsImport.
    basePath: WORKSPACE_ROOT,
    files: ['libs/platform/universal/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            deepImports,
            frameworkImports,
            ...nodeBuiltinImports.patterns,
          ],
          paths: nodeBuiltinImports.paths,
        },
      ],
    },
  },
  {
    // Jest and ESLint config files sit inside pure libs but run on Node.
    basePath: WORKSPACE_ROOT,
    files: ['libs/**/*.config.{cjs,mjs,js,cts,mts,ts}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [deepImports] }],
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

export default eslintConfig;
