/**
 * At-rest encryption for the SystemSettings fields in ENCRYPTED_FIELDS and the
 * User 2FA secret and recovery codes: XChaCha20-Poly1305 with a random 24-byte
 * nonce. `decrypt` fails closed; resolveEncryptedSettings turns a throw into
 * null. Old AES-256-CBC values still read until rewritten; 2FA rows never are.
 */
import crypto from "crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { logger } from "./logger";

const LEGACY_ALGORITHM = "aes-256-cbc";

/** Tag on the new format. Anything without it is read as legacy, or refused. */
const V2_PREFIX = "xc1.";
const V2_INFO = Buffer.from("kima-settings/xc1", "utf8");
const NONCE_BYTES = 24;

// Insecure default that must not be used in production
const INSECURE_DEFAULT = "default-encryption-key-change-me";

/**
 * Get and validate the encryption key from environment
 * Throws error if not set or using insecure default
 */
function getEncryptionKey(): Buffer {
    // Support both SETTINGS_ENCRYPTION_KEY (primary) and ENCRYPTION_KEY (compatibility)
    const key = process.env.SETTINGS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

    if (!key) {
        throw new Error(
            "CRITICAL: SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY environment variable must be set.\n" +
            "This key is required to encrypt sensitive data (API keys, passwords, 2FA secrets).\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    if (key === INSECURE_DEFAULT) {
        throw new Error(
            "CRITICAL: Encryption key is set to the insecure default value.\n" +
            "You must set a unique SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY.\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    if (key.length < 32) {
        logger.warn("SETTINGS_ENCRYPTION_KEY is shorter than 32 characters. Consider using a 32+ char key.");
    }
    // Always derive key via SHA-256 for consistent 256-bit key regardless of input length
    return crypto.createHash("sha256").update(key).digest();
}

// Validate encryption key on module load to fail fast
const ENCRYPTION_KEY = getEncryptionKey();

/**
 * The XChaCha key is a separate derivation from the same secret, not the same
 * 32 bytes reused. One key, one cipher: an AES key and an AEAD key that happen
 * to be equal is the kind of coincidence that becomes a cross-protocol bug the
 * moment anything else starts using either.
 */
const V2_KEY = Buffer.from(
    crypto.hkdfSync("sha256", ENCRYPTION_KEY, Buffer.alloc(0), V2_INFO, 32)
);

// Legacy key derivation for backward compatibility with data encrypted before SHA-256 normalization
function getLegacyEncryptionKey(): Buffer | null {
    const key = process.env.SETTINGS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    if (!key || key.length < 32) return null; // Short keys already used SHA-256
    return Buffer.from(key.slice(0, 32));
}
const LEGACY_KEY = getLegacyEncryptionKey();

/** `ivHex:ciphertextHex` -- the shape every AES-256-CBC value already stored has. */
const LEGACY_SHAPE = /^[0-9a-f]{32}:[0-9a-f]+$/i;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

/**
 * Encrypt a string with XChaCha20-Poly1305.
 * Returns empty string for empty/null input.
 */
export function encrypt(text: string): string {
    if (!text) return "";
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const sealed = xchacha20poly1305(V2_KEY, nonce, V2_INFO).encrypt(
        Buffer.from(text, "utf8")
    );
    return V2_PREFIX + toBase64Url(Buffer.concat([nonce, Buffer.from(sealed)]));
}

/**
 * Decrypt a value from `encrypt` or the older AES-256-CBC format. Throws on
 * tampered, truncated, wrong-key or unrecognised input, never returning it as plaintext.
 */
export function decrypt(text: string): string {
    if (!text) return "";

    if (text.startsWith(V2_PREFIX)) {
        const blob = Buffer.from(text.slice(V2_PREFIX.length), "base64url");
        if (blob.length <= NONCE_BYTES) {
            throw new Error("Decryption failed: ciphertext is too short to be valid");
        }
        // Poly1305 verification happens inside decrypt(); a modified byte
        // anywhere in nonce, ciphertext or tag throws rather than returning
        // plausible-looking bytes.
        const opened = xchacha20poly1305(
            V2_KEY,
            blob.subarray(0, NONCE_BYTES),
            V2_INFO
        ).decrypt(blob.subarray(NONCE_BYTES));
        return Buffer.from(opened).toString("utf8");
    }

    if (LEGACY_SHAPE.test(text)) {
        return decryptLegacy(text);
    }

    // No recognised format: refuse it, or anyone with database access could write
    // a readable credential without the key.
    throw new Error(
        "Decryption failed: value is not in a recognised encrypted format. " +
        "If this is a credential stored before encryption existed, re-enter it in Settings."
    );
}

/** AES-256-CBC, both key derivations, for values written before `xc1.`. */
function decryptLegacy(text: string): string {
    const parts = text.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts.slice(1).join(":"), "hex");

    const attempt = (key: Buffer): string => {
        const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
        return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString();
    };

    try {
        return attempt(ENCRYPTION_KEY);
    } catch (error) {
        if (LEGACY_KEY) {
            // Pre-SHA-256 normalization: the first 32 bytes of the raw env var.
            try {
                return attempt(LEGACY_KEY);
            } catch {
                throw error;
            }
        }
        throw error;
    }
}

/**
 * Whether a stored value is still in the old AES-256-CBC format.
 *
 * Exported for the migration that has to exist before the legacy branch above
 * can go: settings fields re-encrypt whenever they are saved, but nothing ever
 * rewrites `User.twoFactorSecret`.
 */
export function isLegacyCiphertext(value: string | null | undefined): boolean {
    return Boolean(value) && LEGACY_SHAPE.test(value as string);
}

/** Whether a value carries either recognised format (`xc1.` or `iv:cipher`). */
export function isEncryptedFormat(value: string): boolean {
    return value.startsWith(V2_PREFIX) || LEGACY_SHAPE.test(value);
}

/**
 * Encrypt a field value, returning null for empty/null values
 * Useful for database fields that should store null instead of empty encrypted strings
 */
export function encryptField(value: string | null | undefined): string | null {
    if (!value || value.trim() === "") return null;
    return encrypt(value);
}
