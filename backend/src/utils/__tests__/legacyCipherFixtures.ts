import crypto from "crypto";

export const ENV_KEY = process.env.SETTINGS_ENCRYPTION_KEY as string;

/** The legacy key derivation: SHA-256 of the env var. */
export const SHA256_KEY = crypto.createHash("sha256").update(ENV_KEY).digest();

/** The legacy AES-256-CBC stored format: `ivHex:ciphertextHex`. */
export function legacyEncrypt(text: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}
