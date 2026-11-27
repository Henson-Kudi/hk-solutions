import { builtinModules } from 'node:module';
import nx from '@nx/eslint-plugin';
import { depConstraints } from './tools/eslint/boundaries.mjs';

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

const LOG_METHODS = '/^(log|info|warn|error|debug|verbose|fatal|trace)$/';
const LOGGER_NAMES = '/^(log|logger|console)$|logger$/i';
const INTERPOLATED_ARG =
  ':matches(TemplateLiteral[expressions.length>0], BinaryExpression[operator="+"]).arguments';
const logMessage =
  'Log messages are constant strings. Pass values as structured fields so redaction can see them: logger.info("invoice issued", { invoiceId }).';

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
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints,
        },
      ],
      'no-restricted-imports': ['error', { patterns: [deepImports] }],
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
  {
    // Developer command-line scripts print to the terminal, not to service
    // logs, so the constant-log-message rule does not apply to them.
    files: ['tools/**'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Must come after the block above: a later no-restricted-imports entry
    // replaces an earlier one, so this one repeats the deep-import pattern.
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
          paths: nodeBuiltinImports.paths,
        },
      ],
    },
  },
];

export default eslintConfig;
