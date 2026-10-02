// V8 reads the zone once at startup, so TZ is pinned here, before workers spawn
// and inherit it. Set inside a test file it does nothing, and week starts would
// follow the host's zone.
process.env.TZ = 'UTC';

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/src/__mocks__/test-env.cjs'],
    // Reaps ioredis clients (the shared redisClient, BullMQ queue connections,
    // enrichmentState's pair) at every file boundary, so no client opened by a
    // test file's imports keeps the event loop alive after Jest reports done.
    // See clientReaper.cjs.
    setupFilesAfterEnv: ['<rootDir>/src/__mocks__/clientReaper.cjs'],
    // Runs ONCE, in a separate process, before any worker/test file starts --
    // see test-global-setup.cjs for why the vibe-schema bootstrap has to live
    // here rather than in one test file's own beforeAll.
    globalSetup: '<rootDir>/src/__mocks__/test-global-setup.cjs',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    // `@noble/ciphers` is ESM only. Node loads it, but Jest's own registry does
    // not, so it is transformed to CJS rather than mocked: the encryption tests
    // must run the real cipher.
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|eventemitter3|@noble)/)',
    ],
    // The ts-jest preset only claims .ts/.tsx; the second entry is what actually
    // transforms the ESM above. Scoped to .js/.mjs so nothing else changes.
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {}],
        '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
    },
    moduleNameMapper: {
        // p-queue is pure ESM and cannot be required() by Jest's CJS runner.
        // Map it to a minimal CJS mock that executes functions immediately.
        '^p-queue$': '<rootDir>/src/__mocks__/p-queue.cjs',
        // p-limit (and its yocto-queue dep) are pure ESM too; same treatment.
        '^p-limit$': '<rootDir>/src/__mocks__/p-limit.cjs',
        // music-metadata is pure ESM with no CJS entry point; map to a CJS stub.
        '^music-metadata$': '<rootDir>/__mocks__/music-metadata.js',
    },
};
