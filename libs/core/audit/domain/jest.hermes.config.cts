// Same tests as jest.config.cts, run without Node-only globals or modules.
const { hermesTarget } = require('../../../../tools/jest/hermes-target.cjs');

module.exports = hermesTarget(require('./jest.config.cts'));
