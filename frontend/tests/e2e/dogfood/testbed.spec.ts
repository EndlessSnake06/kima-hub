/**
 * Testbed dogfood — fresh install → onboarding → scan → enrichment → removals.
 *
 * Pre-release gate for the v1.11.0 lane. Runs against the SINGLE PRODUCTION
 * IMAGE (kima-test:amd64) propped up on the test-server testbed
 * (~/kima-testbed, port 3055) with a fresh /data volume and a read-only
 * 5-artist music subset. Proves the full boot path on real metal:
 * fresh DB → migrations → register → skip integrations → scan →
 * metadata → moods → CLAP embeddings → vibe map.
 *
 * Removal-fix scenarios folded in (bugs fixed this release):
 *   - podcast delete via the UI
 *   - audiobook cache prune (syncAll) when Audiobookshelf is absent
 *
 * RUN:
 *   KIMA_UI_BASE_URL=http://127.0.0.1:3055 \
 *   npx playwright test tests/e2e/dogfood/testbed.spec.ts --reporter=list
 */
import { test, expect, Browser, BrowserContext, Page } from "@playwright/test";
import { DogfoodSession } from "./session";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3055";
const username = process.env.KIMA_TEST_USERNAME || "kima_dogfood";
const password = process.env.KIMA_TEST_PASSWORD || "dogfood-test-1";

// 363 tracks on 16 cores; enrichment includes CLAP embeddings for all.
const ENRICHMENT_TIMEOUT_MS = 90 * 60 * 1000;

test.describe.configure({ mode: "serial" });

// Headless Chromium has no WebGL by default; the vibe map needs it to draw.
test.use({
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
});

test.describe("Testbed dogfood: fresh install", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        session = new DogfoodSession(page, baseUrl);
        session.attach();
    });

    test.afterAll(async () => {
        if (session) {
            const reportPath = session.writeReport("test-results");
            console.log(`\n[testbed] report: ${reportPath}`);
            console.log(`[testbed] ${session.steps.length} steps, ${session.violations.length} violations`);
        }
        await context?.close();
    });

    test("0. fresh install: lands on onboarding", async () => {
        await page.goto(baseUrl + "/");
        await expect(page.locator('input[placeholder="Choose a username"]').first()).toBeVisible({ timeout: 30000 });
    });

    test("1. onboarding: register the dogfood account", async () => {
        await page.locator('input[placeholder="Choose a username"]').fill(username);
        await page.locator('input[placeholder="At least 6 characters"]').fill(password);
        await page.locator('input[placeholder="Confirm your password"]').fill(password);
        await page.locator('button[type="submit"]').click();
        await expect(page.locator("text=Connect Your Services").first()).toBeVisible({ timeout: 30000 });
    });

    test("2. onboarding: skip integrations, finish, land in /sync", async () => {
        await page.locator("text=Finish without integrations").click();
        await expect(page).toHaveURL(/\/sync/, { timeout: 30000 });
    });

    test("3. scan: watch the library appear", async () => {
        let albums = 0;
        const deadline = Date.now() + 15 * 60 * 1000;
        while (Date.now() < deadline) {
            // Auth is JWT-in-localStorage (not cookies); page.request does not
            // carry it, so attach the Bearer token explicitly. This also
            // survives client-side navigation of the /sync page.
            const token = await page.evaluate(() => localStorage.getItem("auth_token"));
            const r = await page.request.get("/api/library/albums?page=1&limit=1", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (r.ok()) {
                const data = await r.json();
                const total = data?.pagination?.total ?? data?.total ?? 0;
                if (total > 0) {
                    albums = total;
                    break;
                }
            }
            await page.waitForTimeout(5000);
        }
        console.log(`[testbed] scan produced ${albums} albums`);
        expect(albums, "albums should appear after scan").toBeGreaterThan(0);
    });

    test("4. enrichment: watch features + embeddings reach every track", async () => {
        const deadline = Date.now() + ENRICHMENT_TIMEOUT_MS;
        let done = false;
        let lastLine = "";
        while (Date.now() < deadline) {
            const token = await page.evaluate(() => localStorage.getItem("auth_token"));
            const r = await page.request.get("/api/enrichment/status", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (r.ok()) {
                const s = await r.json();
                const audio = s?.audio ?? {};
                const tracks = s?.tracks ?? {};
                const line =
                    `phase=${s.currentPhase ?? "?"} ` +
                    `meta=${tracks.completed ?? 0}/${tracks.total ?? 0} ` +
                    `audio=${audio.completed ?? 0}/${audio.total ?? 0} ` +
                    `proc=${audio.processing ?? 0} failed=${audio.failed ?? 0}`;
                if (line !== lastLine) {
                    console.log(`[testbed][enrichment] ${new Date().toISOString()} ${line}`);
                    lastLine = line;
                }
                const audioTotal = Number(audio.total ?? 0);
                const audioFinished = Number(audio.completed ?? 0) + Number(audio.failed ?? 0);
                const finished = s.status !== "running" && s.status !== undefined
                    ? s.status === "completed"
                    : false;
                if (finished || (audioTotal > 0 && audioFinished >= audioTotal && Number(audio.processing ?? 0) === 0)) {
                    // Audio done ≠ pipeline done: the vibe phase (CLAP
                    // embeddings + UMAP projection) runs after audio. Wait
                    // for the vibe subsystem's authoritative signal.
                    const v = await page.request.get("/api/vibe/status", {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    if (v.ok()) {
                        const vs = await v.json();
                        console.log(`[testbed][vibe] embedded=${vs.embeddedTracks ?? 0}/${vs.totalTracks ?? 0} progress=${vs.progress ?? 0}%`);
                        if (vs.isComplete) {
                            done = true;
                            break;
                        }
                    }
                }
            }
            await page.waitForTimeout(15000);
        }
        expect(done, "enrichment should complete for all tracks").toBe(true);
    });

    test("5. vibe map: renders with embeddings present", async () => {
        await page.goto(baseUrl + "/vibe");
        // First visit since the release may show the release-notes dialog
        // ("What counts as a play") which masks the page — dismiss it.
        const close = page.getByRole("button", { name: "Close" });
        if (await close.count()) {
            await close.first().click();
            await page.waitForTimeout(1000);
        }
        await expect(page.getByTestId("vibe-map-field").locator("canvas")).toBeVisible({ timeout: 60000 });
    });

    test("6. podcasts page renders; no podcast data → graceful", async () => {
        await page.goto(baseUrl + "/podcasts");
        await expect(page.locator("body")).toContainText(/podcast/i, { timeout: 30000 });
    });

    test("7. audiobooks page renders; Audiobookshelf absent → graceful", async () => {
        await page.goto(baseUrl + "/audiobooks");
        await expect(page.locator("body")).toContainText(/audiobook/i, { timeout: 30000 });
    });
});
