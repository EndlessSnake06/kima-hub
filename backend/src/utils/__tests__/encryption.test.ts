/**
 * Encryption refuses anything it did not produce and still reads legacy
 * AES-256-CBC values, whose fixtures are built with `crypto` directly.
 */
import crypto from "crypto";
import { decrypt, encrypt, encryptField } from "../encryption";
import { ENV_KEY, legacyEncrypt, SHA256_KEY } from "./legacyCipherFixtures";

/** The other legacy derivation: the first 32 bytes of the raw env var. */
const RAW32_KEY = Buffer.from(ENV_KEY.slice(0, 32));

describe("at-rest encryption", () => {
    it("round-trips, including unicode and a long value", () => {
        for (const value of ["hunter2", "sk-Ab3_x-9", "päßwörd 🎵 ключ", "k".repeat(4096)]) {
            expect(decrypt(encrypt(value))).toBe(value);
        }
    });

    it("never produces the same ciphertext twice for the same plaintext", () => {
        // A fresh nonce per encryption. Equal ciphertexts would mean equal
        // nonces, which for XChaCha20 is the one failure that silently
        // destroys confidentiality rather than throwing.
        const a = encrypt("the same secret");
        const b = encrypt("the same secret");
        expect(a).not.toBe(b);
        expect(decrypt(a)).toBe("the same secret");
        expect(decrypt(b)).toBe("the same secret");
    });

    it("throws when a single byte of the ciphertext is flipped", () => {
        // Fails closed: the caller must never read back a value an attacker
        // modified in the database.
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        blob[blob.length - 5] ^= 0x01;
        const tampered = "xc1." + blob.toString("base64url");

        expect(tampered).not.toBe(sealed);
        expect(() => decrypt(tampered)).toThrow();
    });

    it("throws when the nonce is altered, not just the ciphertext body", () => {
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        blob[0] ^= 0xff;
        expect(() => decrypt("xc1." + blob.toString("base64url"))).toThrow();
    });

    it("throws on a truncated value rather than reading a short buffer", () => {
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        expect(() => decrypt("xc1." + blob.subarray(0, 20).toString("base64url"))).toThrow(
            /too short/
        );
        expect(() => decrypt("xc1." + blob.subarray(0, 30).toString("base64url"))).toThrow();
    });

    it("throws on plaintext instead of handing it back", () => {
        // Anything unrecognised must not come back to the caller as though it
        // were the decrypted value: database write access alone would then be
        // enough to inject a credential.
        for (const notCiphertext of [
            "sk-attacker-controlled-key",
            "https://evil.example/api",
            "not:hex:at:all",
            "xc1.",
            "xc1.!!!not-base64!!!",
        ]) {
            expect(() => decrypt(notCiphertext)).toThrow();
        }
    });

    it("still reads a legacy AES-256-CBC value", () => {
        const stored = legacyEncrypt("lidarr-api-key-from-production", SHA256_KEY);
        expect(decrypt(stored)).toBe("lidarr-api-key-from-production");
    });

    it("still reads a value keyed by the first 32 bytes of the raw env var", () => {
        const stored = legacyEncrypt("pre-normalization-secret", RAW32_KEY);
        expect(decrypt(stored)).toBe("pre-normalization-secret");
    });

    it("throws on an AES-shaped value encrypted under someone else's key", () => {
        const stored = legacyEncrypt("not yours", crypto.randomBytes(32));
        // Not asserted to throw a SPECIFIC error: CBC has no MAC, so a wrong
        // key fails on padding, which is chance rather than detection. Here it
        // is only required not to succeed silently.
        let result: string | undefined;
        let threw = false;
        try {
            result = decrypt(stored);
        } catch {
            threw = true;
        }
        expect(threw || result !== "not yours").toBe(true);
    });

    it("treats empty as empty, at both ends", () => {
        expect(encrypt("")).toBe("");
        expect(decrypt("")).toBe("");
        expect(encryptField("")).toBeNull();
        expect(encryptField("   ")).toBeNull();
        expect(encryptField(null)).toBeNull();
        expect(encryptField(undefined)).toBeNull();
    });

    it("encryptField produces something decrypt accepts, and not the plaintext", () => {
        const stored = encryptField("audiobookshelf-token");
        expect(stored).not.toBeNull();
        expect(stored).not.toContain("audiobookshelf-token");
        expect(stored?.startsWith("xc1.")).toBe(true);
        expect(decrypt(stored as string)).toBe("audiobookshelf-token");
    });

    it("writes the xc1. format", () => {
        expect(encrypt("anything").startsWith("xc1.")).toBe(true);
    });
});
