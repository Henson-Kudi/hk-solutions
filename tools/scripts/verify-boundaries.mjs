#!/usr/bin/env node
/**
 * Self-test for the architecture rules.
 *
 * Builds throwaway fixture libs, checks that a clean set passes ESLint and
 * dependency-cruiser, then plants one violation per file and checks that each
 * is rejected by the rule that is meant to catch it. Everything it creates is
 * removed afterwards, and tsconfig.base.json is restored byte for byte.
 *
 * Run: node tools/scripts/verify-boundaries.mjs   (or: pnpm verify:boundaries)
 * Exit code 0 means every rule fired as expected.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRY_CODES } from '../eslint/country-literals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSCONFIG = join(ROOT, 'tsconfig.base.json');
const NX_RULE = '@nx/enforce-module-boundaries';
const KERNEL_COUNTRIES = join(
  ROOT,
  'libs/country-packs/kernel/src/lib/country.ts',
);

/** Fixture projects: root folder, import alias and tags. */
const PROJECTS = [
  {
    root: 'libs/platform/zzfix-universal',
    alias: '@hk/platform/zzfix-universal',
    tags: ['scope:platform', 'runtime:universal'],
  },
  {
    root: 'libs/platform/zzfix-node',
    alias: '@hk/platform/zzfix-node',
    tags: ['scope:platform'],
  },
  {
    root: 'libs/core/zzfix/domain',
    alias: '@hk/core/zzfix/domain',
    tags: ['scope:core', 'layer:domain'],
  },
  {
    root: 'libs/products/zzfix-a/domain',
    alias: '@hk/products/zzfix-a/domain',
    tags: ['scope:product', 'product:zzfix-a', 'layer:domain'],
  },
  {
    root: 'libs/products/zzfix-a/application',
    alias: '@hk/products/zzfix-a/application',
    tags: ['scope:product', 'product:zzfix-a', 'layer:application'],
  },
  {
    root: 'libs/products/zzfix-a/infra-pg',
    alias: '@hk/products/zzfix-a/infra-pg',
    tags: ['scope:product', 'product:zzfix-a', 'layer:infra-pg'],
  },
  {
    root: 'libs/products/zzfix-a/nest',
    alias: '@hk/products/zzfix-a/nest',
    tags: ['scope:product', 'product:zzfix-a', 'layer:nest'],
  },
  {
    root: 'libs/products/zzfix-a/infra-node',
    alias: '@hk/products/zzfix-a/infra-node',
    tags: ['scope:product', 'product:zzfix-a', 'layer:infra-node'],
  },
  {
    root: 'libs/products/zzfix-b/domain',
    alias: '@hk/products/zzfix-b/domain',
    tags: ['scope:product', 'product:zzfix-b', 'layer:domain'],
  },
  {
    root: 'libs/products/zzfix-b/infra-pg',
    alias: '@hk/products/zzfix-b/infra-pg',
    tags: ['scope:product', 'product:zzfix-b', 'layer:infra-pg'],
  },
  {
    root: 'libs/country-packs/zzfix',
    alias: '@hk/country-packs/zzfix',
    tags: ['scope:country-pack'],
  },
  {
    root: 'libs/zzfix-untagged',
    alias: '@hk/zzfix-untagged',
    tags: [],
  },
];

/** Files that obey every rule. Both tools must report nothing for these. */
const CLEAN_FILES = {
  'libs/platform/zzfix-universal/src/index.ts': `export const ok = 'ok';\n`,
  'libs/platform/zzfix-node/src/index.ts': `export const nodeOnly = 'node';\n`,
  'libs/core/zzfix/domain/src/index.ts': `export const coreRule = 'core';\n`,
  'libs/products/zzfix-a/domain/src/index.ts': `export * from './lib/thing';\n`,
  'libs/products/zzfix-a/domain/src/lib/thing.ts': `import { ok } from '@hk/platform/zzfix-universal';\n\nexport const thing = ok;\n`,
  'libs/products/zzfix-a/application/src/index.ts': `import { thing } from '@hk/products/zzfix-a/domain';\n\nexport const useCase = () => thing;\n`,
  'libs/products/zzfix-a/infra-pg/src/index.ts': `import { useCase } from '@hk/products/zzfix-a/application';\n\nexport const tableA = { name: 'a', useCase };\n`,
  'libs/products/zzfix-a/nest/src/index.ts': `import { useCase } from '@hk/products/zzfix-a/application';\n\ndeclare const logger: { info(message: string, fields?: object): void };\n\nexport const handler = (invoiceId: string) => {\n  logger.info('invoice issued', { invoiceId });\n  return useCase();\n};\n`,
  'libs/products/zzfix-b/domain/src/index.ts': `export const otherProduct = 'b';\n`,
  'libs/products/zzfix-b/infra-pg/src/index.ts': `export const tableB = { name: 'b' };\n`,
  // A server adapter may use its product's application layer.
  'libs/products/zzfix-a/infra-node/src/index.ts': `import { useCase } from '@hk/products/zzfix-a/application';\n\nexport const adapter = { useCase };\n`,
  'libs/zzfix-untagged/src/index.ts': `export const untagged = 1;\n`,
  // The three places a country code may be written: a pack, seed data, a test.
  'libs/country-packs/zzfix/src/index.ts': `export const packCountry = 'CM';\n`,
  'libs/products/zzfix-a/infra-pg/src/lib/countries.seed.ts': `export const seededCountries = ['CM', 'AE'];\n`,
  'libs/products/zzfix-a/infra-pg/src/seeds/countries.ts': `export const moreSeededCountries = [\`AE\`];\n`,
  'libs/products/zzfix-a/domain/src/lib/thing.spec.ts': `export const fixtureBusiness = { country: 'AE' };\n`,
  // A longer string that merely contains a code is not a country literal.
  'libs/products/zzfix-a/domain/src/lib/locale.ts': `export const locale = 'fr-CM';\n\nexport const label = \`\${locale} CM\`;\n`,
};

/**
 * One planted violation per file. `eslint` and `depcruise` name the rule that
 * must reject it; null means that tool is not expected to see this one.
 */
const VIOLATIONS = [
  {
    name: 'domain imports Nest',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-nest.ts',
    content: `import { Injectable } from '@nestjs/common';\n\nexport const badNest = Injectable;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'domain-is-pure',
  },
  {
    name: 'domain imports Drizzle',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-drizzle.ts',
    content: `import { sql } from 'drizzle-orm';\n\nexport const badDrizzle = sql;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'domain-is-pure',
  },
  {
    name: 'application imports React',
    file: 'libs/products/zzfix-a/application/src/lib/bad-react.ts',
    content: `import { useState } from 'react';\n\nexport const badReact = useState;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'domain-is-pure',
  },
  {
    name: 'domain imports node:crypto',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-node-crypto.ts',
    content: `import { randomUUID } from 'node:crypto';\n\nexport const badCrypto = randomUUID;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'domain-no-node-builtins',
  },
  {
    name: 'domain imports fs',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-fs.ts',
    content: `import { readFileSync } from 'fs';\n\nexport const badFs = readFileSync;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'domain-no-node-builtins',
  },
  {
    name: 'product imports core',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-core.ts',
    content: `import { coreRule } from '@hk/core/zzfix/domain';\n\nexport const badCore = coreRule;\n`,
    eslint: NX_RULE,
    depcruise: 'product-not-to-core',
  },
  {
    name: 'product imports another product',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-cross-product.ts',
    content: `import { otherProduct } from '@hk/products/zzfix-b/domain';\n\nexport const badCross = otherProduct;\n`,
    eslint: NX_RULE,
    depcruise: 'no-cross-product',
  },
  {
    name: 'deep import by relative path',
    file: 'libs/products/zzfix-a/application/src/lib/bad-deep-relative.ts',
    content: `import { thing } from '../../../domain/src/lib/thing';\n\nexport const badDeepRelative = thing;\n`,
    eslint: NX_RULE,
    depcruise: 'no-deep-imports',
  },
  {
    name: 'deep import by alias',
    file: 'libs/products/zzfix-a/application/src/lib/bad-deep-alias.ts',
    content: `import { thing } from '@hk/products/zzfix-a/domain/src/lib/thing';\n\nexport const badDeepAlias = thing;\n`,
    eslint: 'no-restricted-imports',
    depcruise: 'not-to-unresolvable',
  },
  {
    name: "infra-pg imports another product's schema",
    file: 'libs/products/zzfix-a/infra-pg/src/lib/bad-schema.ts',
    content: `import { tableB } from '@hk/products/zzfix-b/infra-pg';\n\nexport const badSchema = tableB;\n`,
    eslint: NX_RULE,
    depcruise: 'no-other-schema',
  },
  {
    name: 'a server adapter (infra-node) imports the nest layer',
    file: 'libs/products/zzfix-a/infra-node/src/lib/bad-nest-layer.ts',
    content: `import { handler } from '@hk/products/zzfix-a/nest';\n\nexport const badAdapter = handler;\n`,
    eslint: NX_RULE,
    depcruise: null,
  },
  {
    name: 'the application layer imports a server adapter (infra-node)',
    file: 'libs/products/zzfix-a/application/src/lib/bad-adapter.ts',
    content: `import { adapter } from '@hk/products/zzfix-a/infra-node';\n\nexport const badUse = adapter;\n`,
    eslint: NX_RULE,
    depcruise: null,
  },
  {
    name: 'domain imports the application layer',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-layer.ts',
    content: `import { useCase } from '@hk/products/zzfix-a/application';\n\nexport const badLayer = useCase;\n`,
    eslint: NX_RULE,
    depcruise: null,
  },
  {
    name: 'universal platform lib imports a node-only platform lib',
    file: 'libs/platform/zzfix-universal/src/lib/bad-runtime.ts',
    content: `import { nodeOnly } from '@hk/platform/zzfix-node';\n\nexport const badRuntime = nodeOnly;\n`,
    eslint: NX_RULE,
    depcruise: null,
  },
  {
    name: 'untagged project imports a lib',
    file: 'libs/zzfix-untagged/src/lib/bad-untagged.ts',
    content: `import { ok } from '@hk/platform/zzfix-universal';\n\nexport const badUntagged = ok;\n`,
    eslint: NX_RULE,
    depcruise: null,
  },
  {
    name: 'circular dependency',
    file: 'libs/products/zzfix-a/nest/src/lib/cycle-a.ts',
    content: `import { cycleB } from './cycle-b';\n\nexport const cycleA = (): string => cycleB();\n`,
    eslint: null,
    depcruise: 'no-circular',
  },
  {
    // Other half of the cycle above. dependency-cruiser reports a cycle once,
    // from one of its files, so nothing is asserted here.
    name: 'circular dependency (second file)',
    file: 'libs/products/zzfix-a/nest/src/lib/cycle-b.ts',
    content: `import { cycleA } from './cycle-a';\n\nexport const cycleB = (): string => cycleA();\n`,
    eslint: null,
    depcruise: null,
  },
  {
    name: 'domain uses the Node-only global Buffer',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-buffer.ts',
    content: `export const badBuffer = Buffer.from('x');\n`,
    eslint: 'no-restricted-globals',
    depcruise: null,
  },
  {
    name: 'application reads process.env',
    file: 'libs/products/zzfix-a/application/src/lib/bad-process.ts',
    content: `export const badProcess = process.env['HOME'];\n`,
    eslint: 'no-restricted-globals',
    depcruise: null,
  },
  {
    name: 'domain imports decimal.js directly',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-decimal.ts',
    content: `import { Decimal } from 'decimal.js';\n\nexport const badDecimal = Decimal;\n`,
    eslint: 'no-restricted-imports',
    depcruise: null,
  },
  {
    name: 'nest layer imports decimal.js directly',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-decimal.ts',
    content: `import { Decimal } from 'decimal.js';\n\nexport const badDecimalNest = Decimal;\n`,
    eslint: 'no-restricted-imports',
    depcruise: null,
  },
  {
    name: 'provider SDK outside its adapter',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-vendor-sdk.ts',
    content: `import Stripe from 'stripe';\n\nexport const badSdk = Stripe;\n`,
    eslint: null,
    depcruise: 'vendor-sdk-only-in-adapter',
  },
  {
    name: '@Global() decorator',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-global.ts',
    content: `declare const Global: () => ClassDecorator;\n\n@Global()\nexport class BadGlobalModule {}\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
  {
    name: 'template-literal log message',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-log-template.ts',
    content: `declare const logger: { info(message: string): void };\n\nexport const badLogTemplate = (phone: string) => {\n  logger.info(\`otp sent to \${phone}\`);\n};\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
  {
    name: 'concatenated log message on this.logger',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-log-concat.ts',
    content: `export class BadLogConcat {\n  constructor(\n    private readonly logger: { error(message: string): void },\n  ) {}\n\n  fail(token: string) {\n    this.logger.error('bad token ' + token);\n  }\n}\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
  {
    name: 'product code compares against a country code',
    file: 'libs/products/zzfix-a/domain/src/lib/bad-country.ts',
    content: `export const isCameroon = (country: string) => country === 'CM';\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
  {
    name: 'country code written as a template literal',
    file: 'libs/products/zzfix-a/application/src/lib/bad-country-template.ts',
    content: `export const defaultCountry = \`AE\`;\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
  {
    name: 'nest layer switches on a country code',
    file: 'libs/products/zzfix-a/nest/src/lib/bad-country-switch.ts',
    content: `export const vatLabel = (country: string) => {\n  switch (country) {\n    case 'AE':\n      return 'VAT';\n    default:\n      return 'TVA';\n  }\n};\n`,
    eslint: 'no-restricted-syntax',
    depcruise: null,
  },
];

const posix = (path) => path.split('\\').join('/');
const fixtureRoots = PROJECTS.map((project) => project.root);

function write(file, content) {
  const target = join(ROOT, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Path to a package's launcher script, read from its own package.json. */
function bin(packageName, command) {
  const packageRoot = join(ROOT, 'node_modules', packageName);
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
  return join(packageRoot, manifest.bin[command]);
}

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NX_DAEMON: 'false', CI: 'true' },
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(tool, result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${tool} did not print JSON (exit ${result.status}).\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** Rebuilds Nx's cached project graph, which the ESLint rule reads. */
function refreshProjectGraph() {
  const result = run(bin('nx', 'nx'), ['show', 'projects']);
  if (result.status !== 0) {
    throw new Error(
      `nx show projects failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** @returns {Map<string, string[]>} file -> rule ids reported as errors */
function runEslint() {
  const result = run(bin('eslint', 'eslint'), [
    '--format',
    'json',
    ...fixtureRoots,
  ]);
  const errors = new Map();
  for (const entry of parseJson('eslint', result)) {
    const file = posix(relative(ROOT, entry.filePath));
    const rules = entry.messages
      .filter((message) => message.severity === 2)
      .map((message) => message.ruleId ?? `fatal: ${message.message}`);
    if (rules.length > 0) errors.set(file, rules);
  }
  return errors;
}

/** @returns {Map<string, string[]>} file -> rule names reported as errors */
function runDepcruise() {
  const result = run(bin('dependency-cruiser', 'depcruise'), [
    'apps',
    'libs',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
  ]);
  const errors = new Map();
  for (const violation of parseJson('depcruise', result).summary.violations) {
    if (violation.rule.severity !== 'error') continue;
    const file = posix(violation.from);
    errors.set(file, [...(errors.get(file) ?? []), violation.rule.name]);
  }
  return errors;
}

function describe(errors) {
  return [...errors]
    .map(([file, rules]) => `    ${file}: ${rules.join(', ')}`)
    .join('\n');
}

function removeIfEmpty(folder) {
  const target = join(ROOT, folder);
  if (existsSync(target) && readdirSync(target).length === 0) rmdirSync(target);
}

function cleanUp(originalTsconfig) {
  writeFileSync(TSCONFIG, originalTsconfig);
  for (const root of fixtureRoots) {
    rmSync(join(ROOT, root), { recursive: true, force: true });
  }
  for (const folder of [
    'libs/products/zzfix-a',
    'libs/products/zzfix-b',
    'libs/core/zzfix',
    'libs/products',
    'libs/core',
    'libs/platform',
    'libs/country-packs',
  ]) {
    removeIfEmpty(folder);
  }
}

/**
 * The lint rule keeps its own copy of the country list, because ESLint cannot
 * import TypeScript. A country in one list and not the other would either be
 * unprotected or impossible to use.
 */
function countryListMismatch() {
  const file = posix(relative(ROOT, KERNEL_COUNTRIES));
  const source = readFileSync(KERNEL_COUNTRIES, 'utf8');
  const match = /COUNTRY_CODES\s*=\s*\[([^\]]*)\]\s*as const/.exec(source);
  if (!match) {
    return `could not find COUNTRY_CODES in ${file}`;
  }
  const kernel = [...match[1].matchAll(/['"]([A-Z]{2})['"]/g)].map(
    (found) => found[1],
  );
  const same =
    kernel.length === COUNTRY_CODES.length &&
    kernel.every((code, index) => code === COUNTRY_CODES[index]);
  return same
    ? null
    : `country lists differ: ${file} has [${kernel.join(', ')}], tools/eslint/country-literals.mjs has [${COUNTRY_CODES.join(', ')}]`;
}

function main() {
  const existing = fixtureRoots.filter((root) => existsSync(join(ROOT, root)));
  if (existing.length > 0) {
    console.error(
      `Fixture folders already exist, refusing to overwrite them:\n  ${existing.join('\n  ')}\nDelete them if they are left over from an interrupted run.`,
    );
    return 2;
  }

  const originalTsconfig = readFileSync(TSCONFIG, 'utf8');
  const failures = [];
  let cleaned = false;
  const cleanUpOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanUp(originalTsconfig);
  };
  process.on('SIGINT', () => {
    cleanUpOnce();
    process.exit(130);
  });

  console.log('0. The lint rule and the kernel must list the same countries');
  const mismatch = countryListMismatch();
  if (mismatch) failures.push(mismatch);
  console.log(`   ${mismatch ? 'FAIL' : 'pass'}`);

  try {
    const tsconfig = JSON.parse(originalTsconfig);
    tsconfig.compilerOptions.paths = {
      ...tsconfig.compilerOptions.paths,
      ...Object.fromEntries(
        PROJECTS.map((project) => [
          project.alias,
          [`./${project.root}/src/index.ts`],
        ]),
      ),
    };
    writeFileSync(TSCONFIG, `${JSON.stringify(tsconfig, null, 2)}\n`);

    for (const project of PROJECTS) {
      write(
        `${project.root}/project.json`,
        `${JSON.stringify(
          {
            name: project.root
              .replace(/^libs\//, '')
              .split('/')
              .join('-'),
            sourceRoot: `${project.root}/src`,
            projectType: 'library',
            tags: project.tags,
            targets: {},
          },
          null,
          2,
        )}\n`,
      );
    }
    // Generated libs each have an eslint.config.mjs that spreads the root
    // config. The fixtures do the same, so the rules are tested the way real
    // projects load them and not only through the root config.
    for (const project of PROJECTS) {
      const toRoot = project.root
        .split('/')
        .map(() => '..')
        .join('/');
      write(
        `${project.root}/eslint.config.mjs`,
        `import baseConfig from '${toRoot}/eslint.config.mjs';\n\nexport default [...baseConfig];\n`,
      );
    }
    for (const [file, content] of Object.entries(CLEAN_FILES))
      write(file, content);
    refreshProjectGraph();

    console.log('1. Clean fixtures must pass');
    const cleanEslint = runEslint();
    const cleanDepcruise = runDepcruise();
    if (cleanEslint.size > 0) {
      failures.push(`clean fixtures failed eslint:\n${describe(cleanEslint)}`);
    }
    if (cleanDepcruise.size > 0) {
      failures.push(
        `clean fixtures failed depcruise:\n${describe(cleanDepcruise)}`,
      );
    }
    console.log(`   eslint: ${cleanEslint.size === 0 ? 'pass' : 'FAIL'}`);
    console.log(`   depcruise: ${cleanDepcruise.size === 0 ? 'pass' : 'FAIL'}`);

    console.log('2. Each planted violation must be rejected');
    for (const violation of VIOLATIONS)
      write(violation.file, violation.content);
    refreshProjectGraph();
    const eslintErrors = runEslint();
    const depcruiseErrors = runDepcruise();

    for (const violation of VIOLATIONS) {
      const checks = [
        ['eslint', violation.eslint, eslintErrors],
        ['depcruise', violation.depcruise, depcruiseErrors],
      ];
      const results = [];
      for (const [tool, expected, errors] of checks) {
        if (expected === null) continue;
        const actual = errors.get(violation.file) ?? [];
        const caught = actual.includes(expected);
        results.push(`${tool} ${caught ? 'ok' : 'MISSED'} (${expected})`);
        if (!caught) {
          failures.push(
            `${violation.name}: ${tool} did not report ${expected} for ${violation.file} (reported: ${actual.join(', ') || 'nothing'})`,
          );
        }
      }
      if (results.length > 0) {
        console.log(`   ${violation.name}: ${results.join('; ')}`);
      }
    }
    // Clean files are not re-checked here: some planted violations create
    // project-level cycles, and Nx then rightly flags every import on the loop.
    // Step 1 is what proves clean code passes.
  } finally {
    cleanUpOnce();
    try {
      refreshProjectGraph();
    } catch {
      // The graph is rebuilt by the next nx command anyway.
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
    return 1;
  }
  console.log(
    `\nAll planted violations were rejected and the clean fixtures passed.`,
  );
  return 0;
}

process.exitCode = main();
