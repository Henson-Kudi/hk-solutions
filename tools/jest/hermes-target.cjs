/**
 * Turns a lib's normal Jest config into its Hermes-compatible one.
 *
 * Usage, in <lib>/jest.hermes.config.cts:
 *
 *   const { hermesTarget } = require('../../../tools/jest/hermes-target.cjs');
 *   module.exports = hermesTarget(require('./jest.config.cts'));
 *
 * and in the lib's project.json:
 *
 *   "test": { "configurations": { "hermes": { "args": ["--config=jest.hermes.config.cts"] } } }
 *
 * Run with: nx run-many -t test --projects=tag:runtime:universal --configuration=hermes
 *
 * What changes compared with the normal run:
 * - the test environment has no Node-only globals (hermes-environment.cjs);
 * - a Node built-in module throws when workspace code imports it
 *   (hermes-runtime.cjs);
 * - files named *.hermes.spec.ts run too. They assert things that are only
 *   true under this target.
 *
 * This is a simulation on V8, not the Hermes engine: npm ships the Hermes
 * compiler but no Hermes runtime. Tests on a real device start with apps/mobile.
 */
const path = require('node:path');

const hermesTarget = (base) => ({
  ...base,
  displayName: `${base.displayName}:hermes`,
  testEnvironment: path.join(__dirname, 'hermes-environment.cjs'),
  runtime: path.join(__dirname, 'hermes-runtime.cjs'),
  testPathIgnorePatterns: ['/node_modules/'],
});

module.exports = { hermesTarget };
