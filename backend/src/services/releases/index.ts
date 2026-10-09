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

export { findRelease, GPU_CHOICE_KEY } from "./catalog";
export type { Release, ReleaseItem } from "./catalog";

async function isAdminUser(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === "admin";
}

/** Whether the library holds enrichment from before `date`: an install upgraded past a release, not a fresh one. */
async function libraryEnrichedBefore(date: Date): Promise<boolean> {
    const [row] = await prisma.$queryRaw<Array<{ older: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM track_embeddings WHERE analyzed_at < ${date})
            OR EXISTS (SELECT 1 FROM "Track" WHERE "analyzedAt" < ${date}) AS older
    `;
    return row?.older === true;
}

/** Releases this user has not yet closed, oldest first, so someone away for three versions reads them in order and
 * answers older consent questions before newer ones that may depend on them. */
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
    // someone with no mood mix to rebuild it would be noise, and asking a
    // non-admin to switch a system-wide setting they cannot change would be
    // worse. The user's role is only read when an item needs it.
    let state: MoodMixState | undefined;
    const mixState = async () => (state ??= await moodMixState(userId));
    let roleChecked: boolean | undefined;
    const isAdmin = async () => (roleChecked ??= await isAdminUser(userId));
    const olderLibrary = new Map<string, Promise<boolean>>();
    const enrichedBefore = (date: string) => {
        if (!olderLibrary.has(date)) olderLibrary.set(date, libraryEnrichedBefore(new Date(date)));
        return olderLibrary.get(date)!;
    };
    const applies = async (item: ReleaseItem, release: Release): Promise<boolean> => {
        if (item.kind === "action" && item.olderLibraryOnly && !(await enrichedBefore(release.date))) return false;
        if (!("requires" in item) || !item.requires) return true;
        if (item.requires === "admin") return isAdmin();
        if (item.kind !== "action") return true;
        const { mix } = await mixState();
        return item.requires === "retiredMoodMix" ? mix?.retired === true : mix?.retired === false;
    };

    const out: Release[] = [];
    for (const r of pending) {
        const items: ReleaseItem[] = [];
        for (const i of r.items) if (await applies(i, r)) items.push(i);
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
                note: undefined,
                title: "One thing left from 1.11",
                summary: "Your old mood mix is still waiting for an answer.",
                items: [retired],
            });
        }
    }
    return out;
}

/**
 * A `/choice` for a key the release never asked about. `moods.mixes.rebuild`
 * is refused too: it is an action, answered through `decideMoodMixes`, which
 * refuses "keep" on a retired mix.
 */
export class UnknownChoiceError extends Error {}

/** Record an explicit answer to one choice. The key must be a `choice` item of that release (else
 * UnknownChoiceError); a later dismissal never overwrites an explicit answer (`dismissRelease`). */
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
 * Close a release for this user: unanswered choices are recorded at their
 * default as DISMISSED; answered ones stay as they are.
 */
export async function dismissRelease(userId: string, version: string): Promise<{
    recordedDefaults: string[];
}> {
    const release = findRelease(version);
    if (!release) return { recordedDefaults: [] };

    // Only the choices this user was actually shown get settled: recording a
    // decline for a question a non-admin was never asked would put a decision
    // on the books that was never theirs to make.
    const asked: Array<{ key: string; defaultValue: boolean }> = [];
    for (const c of choicesIn(release)) {
        if (c.requires === "admin" && !(await isAdminUser(userId))) continue;
        asked.push({ key: c.key, defaultValue: c.defaultValue });
    }
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

/** Whether a user has opted into something. Absent means never asked, which is not consent: `false` either way;
 * reporting reads the table directly for the difference. */
export async function hasOptedIn(userId: string, key: string): Promise<boolean> {
    const row = await prisma.releaseChoice.findUnique({
        where: { userId_key: { userId, key } },
        select: { enabled: true },
    });
    return row?.enabled === true;
}
