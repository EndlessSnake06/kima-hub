/**
 * Per-user scrobble tokens are credentials, so resolution must fail closed:
 * only genuine ciphertext produced by `utils/encryption` resolves. This
 * runs the REAL cipher (no mock of it) against a stubbed database — the
 * four answers are all different outcomes, and only one is a usable token.
 *
 * Run: npx jest src/services/__tests__/listenBrainz.token.test.ts --forceExit --maxWorkers=1
 */

jest.mock("axios", () => ({
    create: () => ({ get: jest.fn(), post: jest.fn() }),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockFindUnique = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { userSettings: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

import { encrypt } from "../../utils/encryption";
import { listenBrainzService } from "../listenBrainz";

describe("getUserToken resolves only genuine ciphertext", () => {
    beforeEach(() => mockFindUnique.mockReset());

    it("decrypts a stored value written by encrypt()", async () => {
        mockFindUnique.mockResolvedValue({ listenbrainzToken: encrypt("real-token") });
        await expect(listenBrainzService.getUserToken("u1")).resolves.toBe("real-token");
    });

    it("returns null when no row exists", async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(listenBrainzService.getUserToken("u2")).resolves.toBeNull();
    });

    it("treats a hand-written plaintext value as not configured", async () => {
        mockFindUnique.mockResolvedValue({ listenbrainzToken: "sneaky-plaintext" });
        await expect(listenBrainzService.getUserToken("u3")).resolves.toBeNull();
    });

    it("treats a bogus xc1.-prefixed blob as not configured", async () => {
        mockFindUnique.mockResolvedValue({ listenbrainzToken: "xc1.not-really-encrypted" });
        await expect(listenBrainzService.getUserToken("u4")).resolves.toBeNull();
    });
});
