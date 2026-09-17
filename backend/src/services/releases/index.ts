/**
 * Deciding what a user still needs to be shown, and recording what they said.
 *
 * The server decides which releases are pending, never the client — otherwise a
 * client could suppress a consent prompt by claiming it had already been seen.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { RELEASES, choicesIn, findRelease, type Release } from "./catalog";

export { RELEASES, findRelease } from "./catalog";
export type { Release, ReleaseItem } from "./catalog";

/**
 * Releases this user has not yet closed, oldest first.
 *
 * Oldest first matters: someone who has been away for three versions should read
 * them in the order they happened, and answer the older consent questions before
 * the newer ones that may depend on them.
 */
export async function pendingReleases(userId: string): Promise<Release[]> {
    const acked = await prisma.releaseAcknowledgement.findMany({
        where: { userId },
        select: { version: true },
    });
    const seen = new Set(acked.map((a) => a.version));
    // Sort oldest-first explicitly rather than trusting the catalog's array
    // order: the array is edited newest-entry-first by habit, and a reader
    // who has been away for three versions must meet them in the order they
    // happened, answering the older consent questions before the newer ones.
    return RELEASES.filter((r) => !seen.has(r.version)).sort((a, b) =>
        a.date === b.date ? a.version.localeCompare(b.version) : a.date < b.date ? -1 : 1,
    );
}

/**
 * Record an explicit answer to one choice.
 *
 * Explicit answers are never overwritten by a later dismissal — see
 * `dismissRelease`.
 */
export async function setChoice(params: {
    userId: string;
    version: string;
    key: string;
    enabled: boolean;
}): Promise<void> {
    const { userId, version, key, enabled } = params;
    await prisma.releaseChoice.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, version, key, enabled, decidedBy: ChoiceDecidedBy.EXPLICIT },
        update: { enabled, decidedBy: ChoiceDecidedBy.EXPLICIT, decidedAt: new Date(), version },
    });
}

/**
 * Close a release for this user, and settle everything it asked.
 *
 * Every choice the user did not answer is written at its default, marked
 * DISMISSED. Choices they *did* answer are left alone — closing the window is
 * not a retraction, and someone who opted in and then hit the X should stay
 * opted in.
 */
export async function dismissRelease(userId: string, version: string): Promise<{
    recordedDefaults: string[];
}> {
    const release = findRelease(version);
    if (!release) return { recordedDefaults: [] };

    const asked = choicesIn(release);
    const recordedDefaults: string[] = [];

    await prisma.$transaction(async (tx) => {
        for (const { key, defaultValue } of asked) {
            const existing = await tx.releaseChoice.findUnique({
                where: { userId_key: { userId, key } },
                select: { decidedBy: true },
            });
            // An explicit yes survives the window being closed.
            if (existing?.decidedBy === ChoiceDecidedBy.EXPLICIT) continue;

            await tx.releaseChoice.upsert({
                where: { userId_key: { userId, key } },
                create: {
                    userId,
                    version,
                    key,
                    enabled: defaultValue,
                    decidedBy: ChoiceDecidedBy.DISMISSED,
                },
                update: { enabled: defaultValue, decidedBy: ChoiceDecidedBy.DISMISSED, version },
            });
            recordedDefaults.push(key);
        }

        await tx.releaseAcknowledgement.upsert({
            where: { userId_version: { userId, version } },
            create: { userId, version },
            update: {},
        });
    });

    if (recordedDefaults.length) {
        logger.debug(
            `[Release] ${version} closed by ${userId}; ${recordedDefaults.length} unanswered ` +
                `choice(s) recorded at their default: ${recordedDefaults.join(", ")}`,
        );
    }
    return { recordedDefaults };
}

/**
 * Whether a user has opted into something.
 *
 * Absent means never asked, which is not consent. Callers get `false` either
 * way; the distinction only matters for reporting, which reads the table
 * directly.
 */
export async function hasOptedIn(userId: string, key: string): Promise<boolean> {
    const row = await prisma.releaseChoice.findUnique({
        where: { userId_key: { userId, key } },
        select: { enabled: true },
    });
    return row?.enabled === true;
}
