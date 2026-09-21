// Minimal jest config for service-level smoke tests that need NO database.
// Omits the DB-provisioning globalSetup and only loads the env setup file.
/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/src/__mocks__/test-env.cjs'],
    roots: ['<rootDir>/src/services'],
    testMatch: ['**/__tests__/**/*.smoke.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|eventemitter3|@noble)/)',
    ],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {}],
        '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
    },
};
