// Minimal jest config for route-level smoke tests that need NO database.
// Exercises the REAL publicVibe router (gate + handlers + rate limiter) with
// only the prisma/service/artwork boundaries mocked.
/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/src/__mocks__/test-env.cjs'],
    roots: ['<rootDir>/src/routes'],
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
