/**
 * The single source of truth for which `SystemSettings` values are stored
 * encrypted, plus the two operations over that list: decrypt-on-read
 * (`resolveEncryptedSettings`) and encrypt-on-write (`encryptSettings`).
 *
 * Before this existed the list was hand-copied in three places — the
 * settings route's GET handler, its POST handler, and `getSystemSettings`
 * — and the copies disagreed: the route encrypted `fanartApiKey`,
 * `slskdApiKey` and `spotifyClientSecret` while the getter decrypted only
 * the other seven, so those three integrations were handed ciphertext
 * where they expected a key.
 *
 * A stored value that no longer decrypts (key rotated, value written
 * without the key, double-encrypted by an old path) is re-seeded to
 * `null` — "unset, needs re-entry" — and admins are notified. Failing
 * closed here is the point: an unreadable credential must never be read
 * back as if it were the credential, and must never stay silently broken.
 */
import { decrypt, encrypt, isEncryptedFormat } from "./encryption";
import { prisma } from "./db";
import { logger } from "./logger";
import { notificationService } from "../services/notificationService";

export const ENCRYPTED_FIELDS = {
    lidarrApiKey: "Lidarr API key",
    lidarrWebhookSecret: "Lidarr webhook secret",
    openaiApiKey: "OpenAI API key",
    fanartApiKey: "Fanart.tv API key",
    acoustidApiKey: "AcoustID API key",
    audiobookshelfApiKey: "Audiobookshelf API key",
    soulseekPassword: "Soulseek password",
    slskdApiKey: "slskd API key",
    spotifyClientSecret: "Spotify client secret",
    listenbrainzUserToken: "ListenBrainz user token",
} as const;

export type EncryptedField = keyof typeof ENCRYPTED_FIELDS;

/** The `SystemSettings` shape with every encrypted field as plaintext. */
export type ResolvedSystemSettings<S> = S & {
    [K in EncryptedField]: string | null;
};

export function encryptedFields(): EncryptedField[] {
    return Object.keys(ENCRYPTED_FIELDS) as EncryptedField[];
}

/** Decrypt a single listed field without re-seeding (comparison sites). */
export function decryptOrNull(
    field: EncryptedField,
    value: string | null | undefined,
): string | null {
    if (!value) return null;
    try {
        const plain = decrypt(value);
        return isEncryptedFormat(plain) ? null : plain;
    } catch (error) {
        logger.warn(`[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted`, error);
        return null;
    }
}

/**
 * Read a settings row into usable values: every `ENCRYPTED_FIELDS` entry
 * decrypted, or `null` plus a re-seed when it cannot be decrypted.
 */
export async function resolveEncryptedSettings<S extends Record<string, unknown>>(
    settings: S,
): Promise<ResolvedSystemSettings<S>> {
    const resolved = { ...settings } as Record<string, unknown>;
    for (const field of encryptedFields()) {
        const stored = settings[field];
        if (typeof stored !== "string" || stored === "") {
            resolved[field] = null;
            continue;
        }
        let plain: string;
        try {
            plain = decrypt(stored);
        } catch {
            await reseedUnreadableField(field);
            resolved[field] = null;
            continue;
        }
        if (isEncryptedFormat(plain)) {
            // Decrypting produced another ciphertext — whatever wrote this
            // value encrypted it twice, and the inner blob is not a key.
            await reseedUnreadableField(field);
            resolved[field] = null;
            continue;
        }
        resolved[field] = plain;
    }
    return resolved as ResolvedSystemSettings<S>;
}

/**
 * Prepare a submitted payload for storage: every supplied
 * `ENCRYPTED_FIELDS` entry encrypted, untouched entries left as submitted.
 */
export function encryptSettings<S extends Record<string, unknown>>(
    settings: S,
): Record<string, unknown> {
    const stored = { ...settings } as Record<string, unknown>;
    for (const field of encryptedFields()) {
        const value = settings[field];
        if (typeof value === "string" && value !== "") {
            stored[field] = encrypt(value);
        }
    }
    return stored;
}

// One "needs re-entry" notification per field per process; the clearing
// itself is idempotent, and the log line repeats so a quiet process does
// not hide a broken key from whoever reads logs.
const notifiedReEntry = new Set<EncryptedField>();

async function reseedUnreadableField(field: EncryptedField): Promise<void> {
    try {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { [field]: null },
        });
        logger.warn(
            `[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted; cleared — re-entry needed`,
        );
    } catch (error) {
        logger.warn(`[Settings] Could not clear unreadable ${field}:`, error);
        return;
    }
    if (notifiedReEntry.has(field)) return;
    notifiedReEntry.add(field);
    try {
        const admins = await prisma.user.findMany({
            where: { role: "admin" },
            select: { id: true },
        });
        await Promise.all(
            admins.map((admin) =>
                notificationService.notifySystem(
                    admin.id,
                    `${ENCRYPTED_FIELDS[field]} needs re-entry`,
                    "The stored value could not be decrypted, so it has been " +
                        "cleared; enter it again in Settings.",
                ),
            ),
        );
    } catch (error) {
        logger.warn(`[Settings] Could not notify admins about ${field}:`, error);
    }
}