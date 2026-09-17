/**
 * What each release tells the user, and what it asks them.
 *
 * This is the file to edit when cutting a release. Everything else about the
 * release window — when it shows, what "closed it" means, how a decision is
 * stored — is machinery that does not change per release.
 *
 * ## Three kinds of item, one mechanism
 *
 * - `note` says something happened. It asks for nothing.
 * - `action` offers something the user can run, once, from the window or later
 *   from settings. It never runs on its own.
 * - `choice` asks permission. It carries an explicit default, and that default
 *   is always `false`.
 *
 * ## Why closing the window is a real answer
 *
 * When the window is dismissed, every `choice` the user did not touch is
 * recorded at its default with `decidedBy: DISMISSED`. Closing and declining
 * land in the same table, in the same shape.
 *
 * That is deliberate. The alternative — leaving unanswered choices absent and
 * inferring later — creates a third state, and a third state eventually gets
 * read optimistically by something that just wants a boolean. Recording the
 * decline outright means no future code can mistake silence for consent, and it
 * means "how many people opted in" has an honest denominator rather than a
 * flattering one.
 */

export type ReleaseItem =
    | {
          kind: "note";
          /** Stable id, so copy can change without losing anything. */
          key: string;
          title: string;
          body: string;
          /** Optional grouping shown as a small label: "Fixed", "Added". */
          label?: string;
      }
    | {
          kind: "action";
          key: string;
          title: string;
          body: string;
          /** The label on the button that runs it. */
          cta: string;
          /** Where it lives permanently, once the window is gone. */
          settingsPath?: string;
      }
    | {
          kind: "choice";
          key: string;
          title: string;
          body: string;
          /**
           * Always false. Present as a field rather than a constant so the shape
           * survives a future opt-out-by-default choice, and so a reader can see
           * what dismissing the window will record.
           */
          defaultValue: false;
          /** What the user gets by saying yes. Written plainly, no selling. */
          benefit?: string;
          /** What actually leaves the machine. Say it exactly. */
          discloses?: string;
      };

export interface Release {
    version: string;
    /** Shown as the window's heading. A name, not a summary. */
    title: string;
    /** One sentence under the heading. */
    summary: string;
    date: string;
    items: ReleaseItem[];
}

export const RELEASES: Release[] = [
    {
        version: "1.11.0",
        title: "A page that knows your habits",
        summary:
            "There's a Stats page now — what you actually listen to, counted honestly — plus a lighter analyzer and a one-off repair for plays the old rule got wrong.",
        date: "2026-09-17",
        items: [
            {
                kind: "note",
                key: "stats.page",
                label: "New",
                title: "The Stats page",
                body:
                    "Everything on it is computed from your own listening: what you replay most, which artists carry half of everything you play, " +
                    "how much of your library has never been heard, and how your habits shift between weeks, months, and all time. " +
                    "The numbers come from one shared definition of a listen, so the page, the player, and the API can't drift apart again.",
            },
            {
                kind: "note",
                key: "player.playcounts",
                label: "New",
                title: "Play counts live in the player",
                body:
                    "The full player now shows how many times you've heard the current track, and the chart behind it is the same data the Stats page uses — " +
                    "not a copy of it, the same source. Tracks you haven't played yet say so instead of showing a zero.",
            },
            {
                kind: "note",
                key: "clap.onnx",
                label: "Changed",
                title: "The vibe analyzer is lighter now",
                body:
                    "Swapped the audio analyzer to ONNX — lighter and more stable across devices, including Apple silicon. Existing fingerprints are outdated.",
            },
            {
                kind: "action",
                key: "plays.repair",
                title: "Fix your old play counts",
                body:
                    "Plays recorded under the old rule (a play was logged the moment a track started loading, skip or not) are still in your history. " +
                    "There's a tool on the Stats page that finds them: it looks for a play followed seconds later by a different track — the signature of a skip — " +
                    "shows you exactly what it found, and only removes what it can prove. Your music files are never touched.\n\n" +
                    "You can run it from here once, or from the Stats page whenever you like.",
                cta: "Take me to it",
                settingsPath: "/stats#false-starts",
            },
            {
                kind: "action",
                key: "clap.reembed",
                title: "Rebuild your embeddings",
                body:
                    "The old fingerprints were made with the previous analyzer, so they no longer line up with the new one. Rebuilding them makes similarity search " +
                    "and the vibe features accurate again.\n\n" +
                    "It re-embeds every track, which is CPU-intensive and can take a long time on a large library. Your music and everything else about it is untouched.",
                cta: "Rebuild your embeddings",
                settingsPath: "/settings#cache",
            },
        ],
    },
    {
        version: "1.10.1",
        title: "What counts as a play",
        summary:
            "Play counts now track what you've listened to, not what started loading. There's a one-off cleanup for the counts you've already got.",
        date: "2026-08-25",
        items: [
            {
                kind: "note",
                key: "plays.rule",
                label: "Changed",
                title: "A play means somebody listened",
                body:
                    "A play used to get logged the second a track started loading, so clicking through an album counted every track you skipped past. " +
                    "Kima now uses the same rule as Last.fm and ListenBrainz. A track counts once you've heard half of it, or four minutes of it, whichever is less. " +
                    "So a 3 minute song needs 90 seconds, and anything over 8 minutes just needs the 4. Tracks 30 seconds or shorter never count at all.",
            },
            {
                kind: "action",
                key: "plays.repair",
                title: "Clean up your old play counts",
                body:
                    "Your existing counts still include all those skips. When one play is followed a few seconds later by another, you clearly weren't listening to the first one, and that gap tells us so. " +
                    "There's a tool on the Stats page that finds them, shows you what it found track by track, and lets you delete them or tell it to leave them alone.\n\n" +
                    "It only ever removes what it can actually prove was a skip. It doesn't read, move, rename or change any of your music files, and it stays there for whenever you want it.",
                cta: "Take me to it",
                settingsPath: "/stats#false-starts",
            },
            {
                kind: "note",
                key: "clap.onnx",
                label: "Changed",
                title: "The vibe analyzer is lighter now",
                body:
                    "Swapped the audio analyzer to ONNX — lighter and more stable across devices, including Apple silicon. Existing fingerprints are outdated.",
            },
            {
                kind: "action",
                key: "clap.reembed",
                title: "Rebuild your embeddings",
                body:
                    "The old fingerprints were made with the previous analyzer, so they no longer line up with the new one. Rebuilding them makes similarity search and the vibe features accurate again.\n\n" +
                    "It re-embeds every track, which is CPU-intensive and can take a long time on a large library. Your music and everything else about it is untouched.",
                cta: "Rebuild your embeddings",
                settingsPath: "/settings#cache",
            },
        ],
    },
];

/** The release a given version belongs to, if the window has anything to say. */
export function findRelease(version: string): Release | undefined {
    return RELEASES.find((r) => r.version === version);
}

/** Every choice a release asks, flattened — used to resolve a dismissal. */
export function choicesIn(release: Release): Array<{ key: string; defaultValue: boolean }> {
    return release.items
        .filter((i): i is Extract<ReleaseItem, { kind: "choice" }> => i.kind === "choice")
        .map((i) => ({ key: i.key, defaultValue: i.defaultValue }));
}
