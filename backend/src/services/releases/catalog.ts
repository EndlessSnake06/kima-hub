/**
 * What each release tells and asks the user; edit this when cutting a release.
 * A `note` informs, an `action` offers something to run, a `choice` asks and
 * defaults to false. Dismissing records untouched choices at their default
 * (`decidedBy: DISMISSED`), so silence is never consent.
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
          /**
           * The action can be run directly from the window (behind a confirm)
           * rather than only linking to its permanent home. When true the gate
           * renders a run control below the CTA link.
           */
          runsFromWindow?: boolean;
          confirmTitle?: string;
          confirmMessage?: string;
          confirmLabel?: string;
          /**
           * What closing the window without acting means for this item, said
           * in the footer. Set it when the item asks for a decision, so the
           * footer does not claim there is nothing to decide.
           */
          ifClosed?: string;
          /**
           * Show only to users it applies to (the server filters in `pendingReleases`):
           * "savedMoodMix" is a mix under a current mood, "retiredMoodMix" one under a
           * mood that no longer exists.
           */
          requires?: "savedMoodMix" | "retiredMoodMix";
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
          /** Only shown to admins when "admin" — the setting it writes is system-wide. */
          requires?: "admin";
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

/**
 * The GPU choice's key. The release window only records the decision;
 * the route applies it through the same service the Settings toggle uses.
 */
export const GPU_CHOICE_KEY = "gpu.accelerate";

export const RELEASES: Release[] = [
    {
        version: "1.11.0",
        title: "No accounts, no keys",
        summary:
            "Last.fm is gone from every feature, and nothing asks you for an account in its place. There's a Stats page, the analyzer is torch-free, and the whole analysis engine was rebuilt. Your library re-analyses itself.",
        date: "2026-10-05",
        items: [
            {
                kind: "note",
                key: "stats.page",
                label: "New",
                title: "The Stats page",
                body:
                    "What you replay most. Which artists carry half of everything you play. How much of your library has never been heard, and how your habits shift between weeks, months, and all time. " +
                    "Every figure comes from one shared definition of a listen, so the page, the player, and the API can't drift apart again.",
            },
            {
                kind: "note",
                key: "player.playcounts",
                label: "New",
                title: "Play counts live in the player",
                body:
                    "The full player now tells you how many times you've heard the current track, pulled from the same counts the Stats page reads. " +
                    "Tracks you haven't played yet say so instead of showing a zero.",
            },
            {
                kind: "note",
                key: "lastfm.gone",
                label: "Changed",
                title: "Last.fm is gone. Nothing to set up",
                body:
                    "Similar artists come from ListenBrainz's worldwide listening data, with Deezer related artists as fallback. Names and aliases resolve " +
                    "through MusicBrainz, biographies through Wikidata, album artwork through Deezer and Cover Art Archive. No API keys, no account, " +
                    "nothing to configure. Tracks without an embedded identifier are identified by a title-checked name search; fingerprint lookup runs " +
                    "only on what that can't settle.",
            },
            {
                kind: "note",
                key: "clap.onnx",
                label: "Changed",
                title: "The vibe analyzer is lighter now",
                body:
                    "Swapped the audio analyzer to ONNX: lighter, torch-free, byte-reproducible, and it runs on Apple silicon. The old fingerprints no " +
                    "longer line up with it; the re-analysis note below says what happens next.",
            },
            {
                kind: "action",
                key: "moods.mixes",
                title: "Your mood mix needs rebuilding",
                body:
                    "Moods were being read backwards: calm tracks could land in Intense, sad ones in Upbeat. That's fixed, and every track's mood is being re-analysed. " +
                    "Your saved mood mix was picked from the old, wrong moods.\n\n" +
                    "Rebuild clears it; pick a mood in the Mood Mixer on the home page to make a fresh one. Keep leaves it exactly as it is. " +
                    "If you like it as it is, save it as a playlist first. Then you can rebuild and still keep those tracks.",
                cta: "Rebuild",
                ifClosed: "If you close now, your mood mix stays as it is.",
                requires: "savedMoodMix",
            },
            {
                kind: "action",
                key: "moods.mixes.retired",
                title: "Your old mood mix can't be shown any more",
                body:
                    "Moods were being read backwards, and fixing that left five moods: Upbeat, Melancholic, Calm, Intense and Energetic. " +
                    "Your saved mood mix was made under one that's gone, so Kima can't show it any more. Its tracks are all still in your library.\n\n" +
                    "Save it as a playlist to keep those tracks together, or remove it. Nothing is deleted until you pick one.",
                cta: "Save as playlist",
                ifClosed: "If you close now, nothing is deleted, and you'll be asked again next time.",
                requires: "retiredMoodMix",
            },
            {
                kind: "note",
                key: "engine.identification",
                label: "New",
                title: "Identification starts with the name",
                body:
                    "Every track's question now opens with the cheap, honest one: the tags and filename it already carries are searched against the recording they name, " +
                    "and the match is checked against the music you actually own before it's believed. Fingerprinting, the slow and rate-limited route, is saved for what " +
                    "that can't settle. Measured on the tracks that had always gone unidentified, four in five came home on the first pass.",
            },
            {
                kind: "note",
                key: "engine.honest",
                label: "Fixed",
                title: "Numbers only where there's a measurement",
                body:
                    "The analyzers now report only what they actually measured. A value that couldn't be determined stays empty instead of being filled with a guess, " +
                    "and two of the five mood heads that had been read backwards are fixed and re-checked against your whole library, not a sample. " +
                    "A track whose file has gone missing is closed honestly and reopens the day the file returns.",
            },
            {
                kind: "note",
                key: "engine.energy",
                label: "Fixed",
                title: "Energy spread out again",
                body:
                    "The energy and mood score comes from a pair of regression models now, and the old pileup near the top of the scale is gone: " +
                    "the third of your library that used to read as maximum-energy can be Calm again. The mood categories on the map and in mood mixes come out of " +
                    "five independent heads, ranked against your own library, so one loud classifier can't stamp half the collection.",
            },
            {
                kind: "note",
                key: "engine.redo",
                label: "Heads up",
                title: "Your library is re-analysing itself",
                body:
                    "The new engine writes a new analysis version, so every track is quietly re-queued: audio analysis first, then embeddings, then the vibe map. " +
                    "It runs in the background and will take a while on a large library; everything keeps working with last-known values while it catches up. " +
                    "Progress lives in Settings, under Library Enrichment. If you turn on GPU acceleration in this window, the download goes first " +
                    "and the embedding pass runs on the card.",
            },
            {
                kind: "choice",
                key: GPU_CHOICE_KEY,
                title: "Run embedding rebuilds on an NVIDIA GPU",
                body:
                    "Rebuilding embeddings is the heaviest job your server runs. If Kima's container can see an NVIDIA graphics card, that job can run on the card " +
                    "instead of the processor (measured about 1.5x faster on the embedding step itself), and your CPU is free for the rest of Kima while the rebuild runs.\n\n" +
                    "Switching it on part-way through a rebuild is safe: tracks that are already embedded stay embedded, and the rest run faster as soon as the analyzer " +
                    "restarts. Turning it off removes the download. You can also change this later in Settings, under Library Enrichment.",
                discloses:
                    "Kima downloads twelve pinned packages (about 2 GB) from PyPI, checks every file against a fixed fingerprint, and installs them into your data " +
                    "directory, where they take about 3.4 GB. Nothing about your library leaves your server.",
                defaultValue: false,
                requires: "admin",
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
        ],
    },
];

/** The release a given version belongs to, if the window has anything to say. */
export function findRelease(version: string): Release | undefined {
    return RELEASES.find((r) => r.version === version);
}

/** Every choice a release asks, flattened — used to resolve a dismissal. */
export function choicesIn(
    release: Release,
): Array<{ key: string; defaultValue: boolean; requires?: "admin" }> {
    return release.items
        .filter((i): i is Extract<ReleaseItem, { kind: "choice" }> => i.kind === "choice")
        .map((i) => ({ key: i.key, defaultValue: i.defaultValue, requires: i.requires }));
}
