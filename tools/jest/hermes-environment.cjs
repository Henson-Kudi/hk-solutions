/**
 * Jest environment for the Hermes-compatible test target.
 *
 * Tests still execute on Node's V8, but inside a context with the globals
 * removed that React Native on Hermes does not provide. Code that reaches for
 * one of them fails here with a ReferenceError instead of failing on a phone.
 *
 * The list is deliberately a little stricter than Hermes itself: anything
 * whose support differs between React Native versions is treated as missing.
 * `process` stays because Jest needs it inside the context; pure code is kept
 * away from it by the no-restricted-globals lint rule instead.
 */
const { TestEnvironment } = require('jest-environment-node');

const NOT_ON_HERMES = [
  'Buffer',
  'crypto',
  'structuredClone',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoderStream',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'CompressionStream',
  'DecompressionStream',
];

class HermesEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of NOT_ON_HERMES) {
      delete this.global[name];
    }
    this.global.__HERMES_TARGET__ = true;
  }
}

module.exports = HermesEnvironment;
module.exports.NOT_ON_HERMES = NOT_ON_HERMES;
