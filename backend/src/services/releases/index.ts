/**
 * Deciding what a user still needs to be shown, and recording what they said.
 *
 * The server decides which releases are pending, never the client — otherwise a
 * client could suppress a consent prompt by claiming it had already been seen.
 */

import { ChoiceDecidedBy } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { RELEASES, choicesIn, findRelease, type Release, type ReleaseItem } from "./catalog";
import { MOOD_MIX_RELEASE, moodMixState, type MoodMixState } from "./moodMixes";

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
    const pending = RELEASES.filter((r) => !seen.has(r.version)).sort((a, b) =>
        a.date === b.date ? a.version.localeCompare(b.version) : a.date < b.date ? -1 : 1,
    );

    // Items that only apply to some users are dropped for the rest: asking
    // someone with no mood mix to rebuild it would be noise. The mood-mix
    // state is only read when something depends on it.
    let state: MoodMixState | undefined;
    const mixState = async () => (state ??= await moodMixState(userId));
    const applies = async (item: ReleaseItem): Promise<boolean> => {
        if (item.kind !== "action" || !item.requires) return true;
        const { mix } = await mixState();
        return item.requires === "retiredMoodMix" ? mix?.retired === true : mix?.retired === false;
    };

    const out: Release[] = [];
    for (const r of pending) {
        const items: ReleaseItem[] = [];
        for (const i of r.items) if (await applies(i)) items.push(i);
        out.push(items.length === r.items.length ? r : { ...r, items });
    }

    // A mix under a mood 1.11 removed cannot be shown, so closing the window
    // must not be the last word on it: until the user saves or removes it,
    // the question comes back on the next visit, on its own.
    if (seen.has(MOOD_MIX_RELEASE)) {
        const release = findRelease(MOOD_MIX_RELEASE);
        const retired = release?.items.find((i) => i.kind === "action" && i.requires === "retiredMoodMix");
        const s = retired ? await mixState() : undefined;
        if (release && retired && s?.mix?.retired && s.decision === null && s.playlist === null) {
            out.push({
                ...release,
                title: "One thing left from 1.11",
                summary: "Your old mood mix is still waiting for an answer.",
                items: [retired],
            });
        }
    }
    return out;
}

/**
 * A `/choice` body naming a key the release never asked about.
 *
 * The choice endpoint records deliberate consent, so a made-up key must not
 * land in the table as one — and `moods.mixes.rebuild` must not arrive through
 * this door either: it is an `action`, and its answers belong to
 * `decideMoodMixes`, which refuses "keep" on a retired mix. Letting the choice
 * endpoint take the key would be a way around that refusal.
 */
export class UnknownChoiceError extends Error {}

/**
 * Record an explicit answer to one choice.
 *
 * The key must be a `choice` item of that release; anything else is
 * UnknownChoiceError. Explicit answers are never overwritten by a later
 * dismissal — see `dismissRelease`.
 */
export async function setChoice(params: {
    userId: string;
    version: string;
    key: string;
    enabled: boolean;
}): Promise<void> {
    const { userId, version, key, enabled } = params;
    const release = findRelease(version);
    if (!release || !choicesIn(release).some((c) => c.key === key)) {
        throw new UnknownChoiceError(key);
    }
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
