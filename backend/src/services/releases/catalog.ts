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
