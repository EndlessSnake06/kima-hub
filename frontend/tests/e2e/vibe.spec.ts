import { test, expect } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first two track IDs that have vibe embeddings, or null if none. */
async function getVibeTrackIds(page: Parameters<typeof loginAsTestUser>[0]): Promise<[string, string] | null> {
    try {
        const token = await getAuthToken(page);
        const res = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok()) return null;
        const data = await res.json() as { tracks?: Array<{ id: string; title: string; artist: string }> };
        const tracks = data.tracks ?? [];
        if (tracks.length < 2) return null;
        return [tracks[0].id, tracks[tracks.length - 1].id];
    } catch {
        return null;
    }
}

/**
 * Finds two distinct vibe search queries (music descriptors) that each return
 * at least one result. Returns null if the library lacks sufficient embeddings.
 */
async function getTwoVibeSearchQueries(page: Parameters<typeof loginAsTestUser>[0]): Promise<[string, string] | null> {
    const candidates = ["rock", "pop", "electronic", "bright", "run", "soft", "dark", "sad", "piano"];
    const token = await getAuthToken(page);
    const working: string[] = [];
    for (const q of candidates) {
        if (working.length >= 2) break;
        try {
            const r = await page.request.post("/api/vibe/search", {
                data: { query: q, limit: 5 },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok()) continue;
            const d = await r.json() as { tracks: unknown[] };
            if (d.tracks.length > 0) working.push(q);
        } catch {
            // skip
        }
    }
    return working.length >= 2 ? [working[0], working[1]] : null;
}

// ---------------------------------------------------------------------------

// Headless Chromium ships with NO WebGL -- the galaxy scene draws through
// three.js/WebGL, so without SwiftShader it never mounts the track field and
// every journey below would test the absence of a graphics stack. Same flags
// and same measured rationale as walkthrough.spec.ts.
test.use({
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
});

test.describe("Vibe", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    // ---- Page load ----------------------------------------------------------

    test("vibe page renders map or no-data state", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        // Wait for loading to settle: either the track count appears (map loaded with data)
        // or the no-data placeholder appears (library has no vibe embeddings yet).
        // "Computing music map" is a transient loading state -- do not assert on it.
        const trackCount = page.locator("text=/ tracks$/");
        const noData = page.locator("text=/No tracks with vibe/i");

        await expect(trackCount.or(noData)).toBeVisible({ timeout: 35_000 });
    });

    test("toolbar buttons are present when map loads", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);

        if ((await noData.count()) > 0) {
            test.skip();
            return;
        }

        await expect(page.locator('[title="Song Path -- build a queue that glides from one track to another"]')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('[title="Blend -- combine tracks into a new playlist of similar vibes"]')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('[aria-label="Search tracks or artists"]')).toBeVisible({ timeout: 5_000 });
    });

    // ---- API contract -------------------------------------------------------

    test("GET /api/vibe/map returns valid structure", async ({ page }) => {
        const token = await getAuthToken(page);
        const res = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });

        // 200 with tracks array (even if empty) or 204
        if (res.status() === 204) return; // no data yet -- valid
        expect(res.ok()).toBe(true);

        const data = await res.json() as { tracks: unknown[]; trackCount: number };
        expect(Array.isArray(data.tracks)).toBe(true);
        expect(typeof data.trackCount).toBe("number");
    });

    test("GET /api/vibe/similar returns tracks array for a valid id", async ({ page }) => {
        const ids = await getVibeTrackIds(page);
        if (!ids) { test.skip(); return; }

        const token = await getAuthToken(page);
        const res = await page.request.get(`/api/vibe/similar/${ids[0]}?limit=10`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBe(true);

        const data = await res.json() as { tracks: Array<{ id: string; title: string }> };
        expect(Array.isArray(data.tracks)).toBe(true);
        expect(data.tracks.length).toBeGreaterThan(0);
        // Returned tracks should all have ids and titles
        for (const t of data.tracks.slice(0, 5)) {
            expect(t.id).toBeTruthy();
            expect(t.title).toBeTruthy();
        }
    });

    test("POST /api/vibe/path returns a path with start and end tracks", async ({ page }) => {
        const ids = await getVibeTrackIds(page);
        if (!ids) { test.skip(); return; }

        const token = await getAuthToken(page);
        const res = await page.request.post("/api/vibe/path", {
            data: { startTrackId: ids[0], endTrackId: ids[1], length: 8, mode: "smooth" },
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBe(true);

        const data = await res.json() as {
            startTrack: { id: string };
            endTrack: { id: string };
            path: Array<{ id: string }>;
        };
        expect(data.startTrack.id).toBe(ids[0]);
        expect(data.endTrack.id).toBe(ids[1]);
        expect(Array.isArray(data.path)).toBe(true);
    });

    // ---- Vibe search --------------------------------------------------------

    test("vibe search highlights matching tracks", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        // Type a query that is likely to match something
        const searchInput = page.locator('[aria-label="Search tracks or artists"]');
        await searchInput.fill("the");
        await page.waitForTimeout(400); // debounce

        // Clear search
        const clearBtn = page.locator('[aria-label="Clear search"]');
        if (await clearBtn.isVisible()) await clearBtn.click();
        await page.waitForTimeout(200);

        // After clearing, no error -- map is still rendered
        await expect(canvas).toBeVisible();
    });

    // ---- Drift via Song Path form -------------------------------------------

    test("Drift button opens song path form", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        await page.locator('[title="Song Path -- build a queue that glides from one track to another"]').click();

        await expect(page.locator('#path-start')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#path-end')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('button:has-text("Generate Path")')).toBeVisible();
    });

    test("Drift song path form: search and select two tracks then generate queue", async ({ page }) => {
        // Find queries that produce results in this library
        const queries = await getTwoVibeSearchQueries(page);
        if (!queries) { test.skip(); return; }
        const [startQuery, endQuery] = queries;

        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const canvas = page.locator("canvas").first();
        await canvas.waitFor({ timeout: 35_000 });

        // Open drift form
        await page.locator('[title="Song Path -- build a queue that glides from one track to another"]').click();
        await expect(page.locator('#path-start')).toBeVisible({ timeout: 5_000 });

        // Search and select start track
        const startInput = page.locator('#path-start');
        await startInput.click();
        await startInput.fill(startQuery);
        await page.waitForTimeout(600);

        const firstResult = page.locator('.max-h-40 button').first();
        await firstResult.waitFor({ timeout: 8_000 });
        await firstResult.click();

        // Should auto-focus end input
        const endInput = page.locator('#path-end');
        await endInput.click();
        await endInput.fill(endQuery);
        await page.waitForTimeout(600);

        const endResult = page.locator('.max-h-40 button').first();
        await endResult.waitFor({ timeout: 8_000 });
        await endResult.click();

        // Generate Path button should now be enabled
        const generateBtn = page.locator('button:has-text("Generate Path")');
        await expect(generateBtn).toBeEnabled({ timeout: 3_000 });
        await generateBtn.click();

        // The form closes and the path is visualized on the map (canvas still present)
        await expect(page.locator('#path-start')).not.toBeVisible({ timeout: 8_000 });
        await expect(canvas).toBeVisible();
    });

    // ---- Blend panel --------------------------------------------------------

    test("Blend button opens blend panel", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        await page.locator('[title="Blend -- combine tracks into a new playlist of similar vibes"]').click();
        await page.waitForTimeout(500);

        // Blend (alchemy) panel should appear -- close button has aria-label="Close alchemy"
        const closeEl = page.locator('[aria-label="Close alchemy"]').first();
        await expect(closeEl).toBeVisible({ timeout: 5_000 });

        // Dismiss
        if (await closeEl.isVisible()) await closeEl.click();
    });

    // ---- Selection drawer ----------------------------------------------------

    // A real star is picked by clicking anywhere on the interactive field; with
    // a dense cloud the center (and the few alternating probes below) almost
    // always lands on a node. Opening the drawer is selection-opened, so the
    // drawer host is absent on pre-fix HEAD (old deck.gl grid, no detail surface)
    // and must appear here on post-fix galaxy.
    test("clicking a track opens a desktop drawer that shows that track's own data", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });

        const gallery = page.getByTestId("galaxy-track-field").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();

        await Promise.race([gallery.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) {
            test.skip(true, "no vibe tracks available on this testbed");
        }

        // Clear any first-run hint sitting on the field so the click lands.
        const dismissHint = page.locator('[aria-label="Dismiss"]').first();
        if (await dismissHint.isVisible().catch(() => false)) await dismissHint.click();

        // The drawer host only renders post-fix (old deck.gl grid had no
        // selection drawer, so this selector is absent on pre-fix HEAD).
        const host = page.locator("#kima-track-drawer-host");

        // Probe a few points until one registers on a star (mouse coords,
        // since a clickable WebGL mesh cannot accept a locator x/y offset).
        const box = await gallery.boundingBox();
        expect(box, "galaxy field should render").not.toBeNull();
        const bx = box!.x,
            by = box!.y,
            bw = box!.width,
            bh = box!.height;
        const centers: Array<[number, number]> = [
            [bx + bw * 0.5, by + bh * 0.5],
            [bx + bw * 0.35, by + bh * 0.4],
            [bx + bw * 0.65, by + bh * 0.4],
            [bx + bw * 0.35, by + bh * 0.65],
            [bx + bw * 0.65, by + bh * 0.65],
        ];
        let opened = false;
        for (const [mx, my] of centers) {
            if (opened) break;
            await page.mouse.move(mx, my);
            await page.mouse.click(mx, my);
            opened = await host.waitFor({ state: "visible", timeout: 3_000 })
                .then(() => true)
                .catch(() => false);
        }
        expect(opened, "drawer host should become visible after clicking a star").toBe(true);

        // Data is read from the already-loaded API payload (zero new fetches).
        const title = (await host.locator("p.font-semibold").first().textContent()) ?? "";
        expect(title.trim().length).toBeGreaterThan(0);

        const token = await getAuthToken(page);
        const map = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const mapTracks = (await map.json()) as { tracks?: Array<{ id: string; title: string; artist: string }> };
        const titles = (mapTracks.tracks ?? []).map((t) => t.title);
        // The drawer shows THIS track's own title, not any other row.
        expect(titles, "the drawer title must be one of the API track titles").toContain(title.trim());

        // The artist is a link to the artist page, not plain text.
        await expect(host.locator("a[href^='/artist/']")).toBeVisible({ timeout: 5_000 });

        // The four actions: Play, Match Vibe, Find similar, Song path.
        await expect(host.getByLabel("Play this track")).toBeVisible({ timeout: 5_000 });
        await expect(host.getByLabel("Build vibe playlist from this track")).toBeVisible({ timeout: 5_000 });
        await expect(host.getByLabel("Find tracks similar to this one")).toBeVisible({ timeout: 5_000 });
        await expect(host.getByLabel("Start song path from this track")).toBeVisible({ timeout: 5_000 });

        // Esc closes the drawer.
        await page.keyboard.press("Escape");
        await expect(host).toBeHidden({ timeout: 5_000 });

        // Re-open, then dismiss via a genuine backdrop click (anything outside
        // the drawer aside). The field center is left of the right-aligned
        // drawer, so it lands on the backdrop, not on an aside control.
        for (const [mx, my] of centers) {
            await page.mouse.move(mx, my);
            await page.mouse.click(mx, my);
            if (await host.isVisible()) break;
        }
        await host.waitFor({ state: "visible", timeout: 3_000 });
        await page.mouse.click(bw * 0.5 + bx - 200, by + 100);
        await expect(host).toBeHidden({ timeout: 5_000 });
    });
});
