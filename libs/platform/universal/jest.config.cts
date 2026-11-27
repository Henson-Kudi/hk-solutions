module.exports = {
  displayName: 'platform-universal',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../../coverage/libs/platform/universal',
  // *.hermes.spec.ts files only hold under the Hermes-compatible target.
  testPathIgnorePatterns: ['/node_modules/', '\\.hermes\\.spec\\.ts$'],
};
