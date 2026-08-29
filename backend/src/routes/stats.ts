/**
 * One read for the whole Stats page.
 *
 * The page is a single scroll, so it is a single request. Four independent
 * gathers run concurrently and the slowest one sets the latency; splitting them
 * into four endpoints would only mean four waterfalls and four spinners.
 *
 * The server half is omitted entirely for non-admins rather than blanked out.
 * An absent key is a clearer contract than a key full of zeroes, and it means
 * a regular user's response never carries numbers about the machine.
 *
 * Actions are not here. Clearing caches, clearing finished jobs and retrying
 * failures already have endpoints; this page calls those.
 */

import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { hourDetail, listeningStats, regionDetail, trackPlayCount } from "../services/stats/listening";
import { shelfStats } from "../services/stats/shelf";
import { signature } from "../services/stats/signature";
import { playableSlice, type Slice } from "../services/stats/playable";
import { asPeriod } from "../services/stats/listens";
import { spokenStats } from "../services/stats/spoken";
import { systemStats } from "../services/stats/system";
import {
    auditFalseStarts,
    collapseDuplicateRows,
    ignoreTracks,
    removeFalseStarts,
    unignoreTracks,
} from "../services/playHistoryRepair";

const router = Router();
router.use(requireAuth);

/**
 * GET /stats?tz=Europe/London
 *
 * The timezone is the client's own IANA zone. Without it the hour-of-day grid
 * would be drawn in UTC, which tells a person nothing about their own evenings.
 */
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const isAdmin = req.user!.role === "admin";
        const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
        const period = asPeriod(req.query.period);

        // `shelf`, `spoken` and `system` take no window on purpose. They are not
        // made of listening events: the shelf is what the server holds, spoken
        // time is a stored position rather than a stream of plays, and the
        // machine has no history at all. Narrowing them to thirty days would
        // produce numbers that are true and useless — "you have heard 0.4% of
        // your shelf this month" — so they stay all-time and the page labels
        // them as such rather than quietly ignoring the control.
        const [listening, shelf, spoken, sig, system] = await Promise.all([
            listeningStats(userId, tz, period),
            shelfStats(userId),
            spokenStats(userId),
            signature(userId, tz ?? "UTC", period),
            isAdmin ? systemStats(config.version) : Promise.resolve(undefined),
        ]);

        res.json({ period, listening, shelf, spoken, signature: sig, ...(system ? { system } : {}) });
    } catch (error) {
        logger.error("[Stats] failed to gather:", error);
        res.status(500).json({ error: "Failed to load stats" });
    }
});

/**
 * GET /stats/hour?dow=4&hour=19&tz=... — what was playing in one cell of the week.
 *
 * Separate from the page's own read because most visits never ask it, and 168
 * cells of track lists is a payload nobody would look at.
 */
router.get("/hour", async (req, res) => {
    try {
        const dow = Number(req.query.dow);
        const hour = Number(req.query.hour);
        if (!Number.isInteger(dow) || dow < 0 || dow > 6 ||
            !Number.isInteger(hour) || hour < 0 || hour > 23) {
            return res.status(400).json({ error: "Bad request" });
        }
        const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
        res.json(await hourDetail(req.user!.id, dow, hour, tz, asPeriod(req.query.period)));
    } catch (error) {
        logger.error("[Stats] hour detail failed:", error);
        res.status(500).json({ error: "Failed to read that hour" });
    }
});

/**
 * GET /stats/tracks?of=never — a slice of the page, as something you can play.
 *
 * Every value of `of` corresponds to a figure the page already states, so this
 * never answers a question the reader has not been shown.
 */
const SLICES = new Set<Slice>(["top", "never", "core", "key", "decade"]);

router.get("/tracks", async (req, res) => {
    try {
        const of = String(req.query.of ?? "") as Slice;
        if (!SLICES.has(of)) return res.status(400).json({ error: "Bad request" });
        const tracks = await playableSlice({
            userId: req.user!.id,
            slice: of,
            key: typeof req.query.key === "string" ? req.query.key : undefined,
            decade: req.query.decade ? Number(req.query.decade) : undefined,
            // `Number("abc")` is NaN, which is not nullish, so it survived
            // `?? 40` and `Math.min`/`Math.max` and reached LIMIT — a 500 where
            // the answer is "that is not a number".
            limit: Number.isFinite(Number(req.query.limit))
                ? Number(req.query.limit)
                : undefined,
            period: asPeriod(req.query.period),
        });
        res.json({ tracks });
    } catch (error) {
        logger.error("[Stats] playable slice failed:", error);
        res.status(500).json({ error: "Couldn't gather those tracks" });
    }
});

/**
 * GET /stats/track/:id/plays — how many times this person has heard one track.
 *
 * For the line in the player bar. Deliberately its own tiny read rather than a
 * field on the track payload: it changes as you listen, the track payload is
 * cached, and a stale count printed next to a playing song is worse than none.
 */
router.get("/track/:id/plays", async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id || id.length > 64) return res.status(400).json({ error: "Bad request" });
        res.json({ plays: await trackPlayCount(req.user!.id, id) });
    } catch (error) {
        logger.error("[Stats] track play count failed:", error);
        res.status(500).json({ error: "Couldn't count that track" });
    }
});

/** GET /stats/region?x=12&y=18 — what sits at one point of the taste plot. */
router.get("/region", async (req, res) => {
    try {
        const x = Number(req.query.x);
        const y = Number(req.query.y);
        if (!Number.isInteger(x) || x < 1 || x > 24 || !Number.isInteger(y) || y < 1 || y > 24) {
            return res.status(400).json({ error: "Bad request" });
        }
        res.json(await regionDetail(req.user!.id, x, y, undefined, asPeriod(req.query.period)));
    } catch (error) {
        logger.error("[Stats] region detail failed:", error);
        res.status(500).json({ error: "Failed to read that region" });
    }
});

/* ── The play-history audit ──────────────────────────────────────────────────
 *
 * A permanent maintenance tool, not a one-off migration. It lives beside the
 * stats it corrects, because the reason to run it is having just looked at a
 * number and not believed it.
 *
 * Reading is separate from acting, and acting takes track ids only. Which plays
 * die is decided in the service, on current data — see the note there.
 * ─────────────────────────────────────────────────────────────────────────── */

/** At most this many tracks may be named in one action. */
const MAX_TRACKS_PER_ACTION = 2000;

const trackListSchema = z.object({
    trackIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_TRACKS_PER_ACTION),
});

/** GET /stats/false-starts — what the audit can prove, grouped by track. */
router.get("/false-starts", async (req, res) => {
    try {
        res.json(await auditFalseStarts(req.user!.id));
    } catch (error) {
        logger.error("[Stats] false-start audit failed:", error);
        res.status(500).json({ error: "Failed to read your play history" });
    }
});

/**
 * POST /stats/false-starts/collapse — merge duplicate records into one row each.
 *
 * Takes no track list because it needs no judgement: a row written while the
 * track was demonstrably still playing describes a listen already counted. This
 * is the safe half of the cleanup and it is offered separately from the half
 * that guesses.
 */
router.post("/false-starts/collapse", async (req, res) => {
    try {
        res.json(await collapseDuplicateRows(req.user!.id));
    } catch (error) {
        logger.error("[Stats] collapse failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/remove — delete the provable ones on these tracks. */
router.post("/false-starts/remove", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await removeFalseStarts(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: "Bad request" });
        logger.error("[Stats] false-start removal failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/ignore — stop raising these. Deletes nothing. */
router.post("/false-starts/ignore", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await ignoreTracks(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: "Bad request" });
        logger.error("[Stats] ignore failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/restore — put ignored tracks back in the audit. */
router.post("/false-starts/restore", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await unignoreTracks(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: "Bad request" });
        logger.error("[Stats] restore failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

export default router;
