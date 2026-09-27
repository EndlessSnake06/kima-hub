/**
 * The encrypted-settings ladder at its failure edges.
 *
 * Before the single `ENCRYPTED_FIELDS` map, the settings route encrypted
 * `fanartApiKey`, `slskdApiKey` and `spotifyClientSecret` while the getter
 * decrypted only the other seven: those three integrations were handed
 * ciphertext where they expected a key. And values written by the old paths
 * (double-encrypted, or encrypted under since-rotated keys) came back as
 * unreadable strings or as the ciphertext itself.
 *
 * This test runs the REAL cipher (no mock of encryption.ts) over four
 * kinds of stored values: correct ciphertext, double-encrypted, garbage,
 * and legacy AES — and requires that broken ones are re-seeded to null
 * with a "needs re-entry" notification, good ones resolve, and the
 * notification for a field is sent once per process.
 */

const mockUpdate = jest.fn().mockResolvedValue({});
const mockFindAdmins = jest.fn().mockResolvedValue([{ id: "admin1" }]);
const mockNotify = jest.fn().mockResolvedValue(undefined);

jest.mock("../db", () => ({
    prisma: {
        systemSettings: { update: (...a: unknown[]) => mockUpdate(...a) },
        user: { findMany: (...a: unknown[]) => mockFindAdmins(...a) },
    },
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: {
        notifySystem: (...a: unknown[]) => mockNotify(...a),
    },
}));

jest.mock("../logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import crypto from "crypto";

import {
    ENCRYPTED_FIELDS,
    decryptOrNull,
    encryptSettings,
    resolveEncryptedSettings,
} from "../encryptedFields";
import { encrypt } from "../encryption";

const ENV_KEY = process.env.SETTINGS_ENCRYPTION_KEY as string;
const SHA256_KEY = crypto.createHash("sha256").update(ENV_KEY).digest();

/** Exactly what the pre-XChaCha implementation wrote: `ivHex:ciphertextHex`. */
function legacyEncrypt(text: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe("the three fields the old lists disagreed about", () => {
    it("encrypts on write and decrypts on read with the same map", async () => {
        const submitted = {
            fanartApiKey: "fanart-key",
            slskdApiKey: "slskd-key",
            spotifyClientSecret: "spotify-secret",
            musicPath: "/music", // not an encrypted field
        };

        const stored = encryptSettings(submitted);

        // Stored forms are ciphertext, not the submitted values.
        for (const field of ["fanartApiKey", "slskdApiKey", "spotifyClientSecret"]) {
            expect(stored[field]).not.toBe(submitted[field as keyof typeof submitted]);
            expect(stored[field]).toMatch(/^xc1\./);
        }
        // Untouched keys pass through as submitted.
        expect(stored.musicPath).toBe("/music");

        const resolved = await resolveEncryptedSettings(stored);
        expect(resolved.fanartApiKey).toBe("fanart-key");
        expect(resolved.slskdApiKey).toBe("slskd-key");
        expect(resolved.spotifyClientSecret).toBe("spotify-secret");
        // Nothing broken here, so no re-seed writes.
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("maps every field either side used to read or write alone", () => {
        // The audit's finding 1: the two hand-copied lists had to agree.
        // The roster is the audit's union of ten minus `listenbrainzUserToken`,
        // which retired with the move to per-user scrobble tokens.
        expect(Object.keys(ENCRYPTED_FIELDS)).toHaveLength(9);
        for (const field of ["fanartApiKey", "slskdApiKey", "spotifyClientSecret",
            "lidarrApiKey", "lidarrWebhookSecret", "acoustidApiKey",
            "audiobookshelfApiKey", "soulseekPassword",
            "openaiApiKey"]) {
            expect(ENCRYPTED_FIELDS).toHaveProperty(field);
        }
    });
});

describe("broken stored values re-seed to \"needs re-entry\"", () => {
    it("re-seeds a double-encrypted value and notifies admins", async () => {
        // The M5 case verbatim: an old path encrypted an already-encrypted
        // value; decrypting once yields another ciphertext, which is not a
        // key and must never be handed to a client as one.
        const settings = { lidarrApiKey: encrypt(encrypt("lidarr-key-from-2024")) };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.lidarrApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "default" },
                data: { lidarrApiKey: null },
            }),
        );
        expect(mockNotify).toHaveBeenCalledWith(
            "admin1",
            "Lidarr API key needs re-entry",
            expect.stringContaining("could not be decrypted"),
        );
    });

    it("re-seeds a value that is in no encrypted format at all", async () => {
        // Never-decrypted: plaintext written straight into the column, or
        // an old failure that stored the key unencrypted. Handing it back
        // would be the fail-open hole the new decrypt refuses.
        const settings = { openaiApiKey: "sk-plaintext-never-encrypted" };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.openaiApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { openaiApiKey: null } }),
        );
    });

    it("re-seeds a ciphertext written under a different key", async () => {
        // Key rotation: the stored value decrypts only under the old key.
        const settings = {
            acoustidApiKey: legacyEncrypt("acoustid-key-from-before-rotation",
                crypto.randomBytes(32)),
        };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.acoustidApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { acoustidApiKey: null } }),
        );
    });

    it("notifies once per field even when the broken value is read twice", async () => {
        // One "needs re-entry" notice per field per process — the clearing
        // is idempotent, the notification must not spam the admin.
        const settings = { soulseekPassword: encrypt(encrypt("hunter2")) };

        await resolveEncryptedSettings(settings);
        await resolveEncryptedSettings(settings);

        const soulseekNotices = mockNotify.mock.calls.filter(
            ([, title]) => title === "Soulseek password needs re-entry",
        );
        expect(soulseekNotices).toHaveLength(1);
    });
});

describe("readable stored values resolve", () => {
    it("decrypts a correct ciphertext and a legacy AES one, without re-seeding", async () => {
        const settings = {
            soulseekPassword: encrypt("soulseek-pass"),
            audiobookshelfApiKey: legacyEncrypt("abs-key", SHA256_KEY),
        };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.soulseekPassword).toBe("soulseek-pass");
        expect(resolved.audiobookshelfApiKey).toBe("abs-key");
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("keeps unset and empty values null without re-seeding", async () => {
        const settings = { lidarrWebhookSecret: "", spotifyClientSecret: null };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.lidarrWebhookSecret).toBeNull();
        expect(resolved.spotifyClientSecret).toBeNull();
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});

describe("decryptOrNull (comparison sites)", () => {
    it("returns null for a double-encrypted value but does not re-seed", async () => {
        // Comparison sites must not rewrite the row while merely looking.
        expect(
            decryptOrNull("lidarrApiKey", encrypt(encrypt("lidarr-key-from-2024"))),
        ).toBeNull();
        expect(decryptOrNull("lidarrApiKey", "garbage")).toBeNull();
        expect(decryptOrNull("lidarrApiKey", encrypt("lidarr-key"))).toBe("lidarr-key");
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});
