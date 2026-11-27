/**
 * Jest runtime for the Hermes-compatible test target.
 *
 * Makes every Node built-in module (fs, node:crypto, path, ...) throw when it
 * is imported from workspace code. Imports made from node_modules still work,
 * because Jest's own assertion library needs Node inside the test context.
 * A third-party package that needs Node is caught earlier, by the lint and
 * dependency-cruiser rules on what pure code may import.
 */
const { isBuiltin } = require('node:module');
const path = require('node:path');
const Runtime = require('jest-runtime').default;

const IN_NODE_MODULES = `${path.sep}node_modules${path.sep}`;

class HermesRuntime extends Runtime {
  requireModuleOrMock(from, moduleName) {
    if (isBuiltin(moduleName) && !from.includes(IN_NODE_MODULES)) {
      throw new Error(
        `Node built-in module "${moduleName}" was imported under the Hermes-compatible test target, from ${from}. ` +
          'Code tagged runtime:universal, and domain and application code, also runs in React Native. ' +
          'Use the helpers in @hk/platform/universal or define a port.',
      );
    }
    return super.requireModuleOrMock(from, moduleName);
  }
}

module.exports = HermesRuntime;
