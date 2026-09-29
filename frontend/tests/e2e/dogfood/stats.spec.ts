/**
 * The stats page, the period filter, the play-history audit, the player's play
 * count and the queue limit — as one real session, watched the whole way.
 *
 * Separate from `walkthrough.spec.ts` on purpose. That file is the whole-app
 * gate and includes an embeddings rebuild that runs for hours; these surfaces
 * change often enough to need a run measured in minutes.
 *
 * It uses the same `DogfoodSession`, so every journey here also fails on a
 * console error, an uncaught exception, a failed request, a horizontal
 * overflow or a dropped event stream — not just on its own assertions.
 *
 * ## What it needs
 *
 * An instance with a real play history for the test user. Figures like "half of
 * everything you play is N songs" have nothing to say about four plays, and a
 * test that asserts on an empty page proves the page renders, not that it is
 * right. `preflight` refuses rather than passing vacuously.
 */

import { test, expect, Browser, Page, BrowserContext } from "@playwright/test";
import { DogfoodSession, settle } from "./session";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";

const PLAYER = '[data-kima-player="main"]';

/** One thread of interaction: the filter journeys mean nothing if the page never loaded. */
test.describe.configure({ mode: "serial" });

test.describe("Dogfood: stats, filters, audit, queue", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let token = "";
    /** Read once so later journeys can assert the page agrees with the API. */
    let allTime: {
        plays: number;
        distinctArtists: number;
        forHalf: number | null;
        neverPlayed: number;
    } | null = null;

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(
            username && password,
            "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set",
        ).toBeTruthy();

        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        session = new DogfoodSession(page, baseUrl);
        session.attach();
    });

    test.afterAll(async () => {
        if (session) {
            const reportPath = session.writeReport("test-results");
            console.log(`\n[stats-dogfood] report written to ${reportPath}`);
            console.log(
                `[stats-dogfood] ${session.steps.length} steps, ${session.violations.length} violations`,
            );
        }
        await context?.close();
    });

    test("1. arrive: sign in and reach the stats page", async () => {
        session.setJourney("1. Arrive");

        // On the login screen the app asks who is signed in and is told nobody.
        // That 401 is the right answer, not a fault. Withdrawn once a session
        // exists, after which a 401 means something genuinely went wrong.
        session.expectFailure({
            urlPattern: /\/api\/auth\/me/,
            status: 401,
            reason: "the session check before anyone has signed in",
        });

        await session.step("sign in", async () => {
            await page.goto("/login");
            await page.locator("#username").fill(username);
            await page.locator("#password").fill(password);
            await page.getByRole("button", { name: /sign in/i }).click();
            await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
            token = await page.evaluate(() => localStorage.getItem("auth_token") ?? "");
            expect(token, "a token should be stored after login").toBeTruthy();
        });

        await session.step("read the API's own answer, to compare the page against", async () => {
            const res = await page.request.get(
                `/api/stats?tz=Europe/London&period=all`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            expect(res.status()).toBe(200);
            const d = await res.json();
            allTime = {
                plays: d.listening.plays,
                distinctArtists: d.listening.distinctArtists,
                forHalf: d.signature.concentration?.forHalf ?? null,
                neverPlayed: d.shelf.neverPlayed,
            };
            expect(
                allTime.plays,
                "this suite needs a real play history; a page of zeroes proves nothing",
            ).toBeGreaterThan(50);
        });

        await session.step("dismiss the release window if it is up", async () => {
            // After an upgrade the What's New dialog opens over everything on
            // first login, so every later journey would be clicking through a
            // modal. Closing it is part of a real first session, not a
            // workaround — and it's worth knowing this gates the whole app.
            // Match ANY release window: the title changes per release and the
            // spec must not break the day a new one ships.
            const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
            if (await dialog.isVisible().catch(() => false)) {
                await page.locator('div[role="dialog"] button[aria-label="Close"]').first().click();
                await expect(dialog).toBeHidden({ timeout: 10_000 });
            } else {
                session.noteNotCovered("no release window was shown on this instance");
            }
        });

        await session.step("the stats page loads", async () => {
            await page.goto("/stats");
            await settle(page);
            await expect(page.getByText(/your listening/i).first()).toBeVisible();
        });

        session.assertClean("1. Arrive");
    });

    test("2. the ledger states the same numbers the API does", async () => {
        session.setJourney("2. Ledger");

        await session.step("the headline figures match the API exactly", async () => {
            const body = await page.locator("main").innerText();
            expect(body).toContain(allTime!.plays.toLocaleString());
            expect(body).toContain(allTime!.distinctArtists.toLocaleString());
            if (allTime!.forHalf !== null) {
                expect(
                    body,
                    "the concentration figure the ledger prints must be the one the API returned",
                ).toContain(`${allTime!.forHalf} songs`);
            }
        });

        await session.step("every chart drew something", async () => {
            // A section that renders its frame and no data reads as a broken
            // page, and has done twice in this page's life.
            const svgShapes = await page.locator("main svg circle, main svg path, main svg rect").count();
            expect(svgShapes, "the charts should have drawn marks, not empty frames").toBeGreaterThan(50);
            const cells = await page.locator("button[data-cell]").count();
            expect(cells, "the week grid is 7x24").toBe(168);
        });

        await session.step("nothing overflows the measure", async () => {
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth > window.innerWidth,
            );
            expect(overflow, "the page must not scroll sideways").toBe(false);
        });

        session.assertClean("2. Ledger");
    });

    test("3. the period filter actually narrows, and says which window it is showing", async () => {
        session.setJourney("3. Period filter");

        let thirtyDayPlays = 0;

        await session.step("switching to 30 days refetches and shows fewer plays", async () => {
            const [res] = await Promise.all([
                page.waitForResponse(
                    (r) => r.url().includes("/api/stats?") && r.url().includes("period=30d"),
                    { timeout: 30_000 },
                ),
                page.getByRole("button", { name: "30 days", exact: true }).click(),
            ]);
            expect(res.status()).toBe(200);
            const d = await res.json();
            expect(d.period, "the server should echo the window it answered for").toBe("30d");
            thirtyDayPlays = d.listening.plays;
            expect(
                thirtyDayPlays,
                "thirty days cannot contain more listening than all time",
            ).toBeLessThanOrEqual(allTime!.plays);
            await settle(page);
        });

        await session.step("the headline says which window it is describing", async () => {
            const hero = await page.locator("main h1").first().innerText();
            expect(
                hero,
                "a figure for one window must not read as a figure for all of them",
            ).toMatch(/last 30 days/i);
        });

        await session.step("the shelf sections declare that they did not move", async () => {
            // They are not made of listening events, so the control cannot reach
            // them. Saying so is the difference between an exception and a lie.
            const body = await page.locator("main").innerText();
            expect(body.toLowerCase()).toContain("all time");
        });

        await session.step("the never-played count is a shelf fact and is unchanged", async () => {
            const res = await page.request.get(`/api/stats?tz=Europe/London&period=30d`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const d = await res.json();
            expect(d.shelf.neverPlayed).toBe(allTime!.neverPlayed);
        });

        await session.step("switching back to all time restores the full figures", async () => {
            await Promise.all([
                page.waitForResponse(
                    (r) => r.url().includes("/api/stats?") && r.url().includes("period=all"),
                    { timeout: 30_000 },
                ),
                page.getByRole("button", { name: "All", exact: true }).click(),
            ]);
            await settle(page);
            const body = await page.locator("main").innerText();
            expect(body).toContain(allTime!.plays.toLocaleString());
        });

        session.assertClean("3. Period filter");
    });

    test("4. every figure the page can play, plays", async () => {
        session.setJourney("4. Playable slices");

        await session.step("a key wedge returns tracks rather than silently nothing", async () => {
            // The wheel folds both spellings of a pitch into one wedge. When the
            // query matched only the wedge's own label, a wedge could show
            // hundreds of listens and hand back an empty queue.
            const res = await page.request.get(`/api/stats?tz=Europe/London&period=all`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const keys = (await res.json()).signature.key;
            test.skip(!keys, "no analysed keys in this library");

            for (const k of keys.all.filter((x: { plays: number }) => x.plays > 0).slice(0, 6)) {
                const slice = await page.request.get(
                    `/api/stats/tracks?of=key&key=${encodeURIComponent(`${k.key} ${k.scale}`)}&limit=10`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                expect(slice.status()).toBe(200);
                const { tracks } = await slice.json();
                expect(
                    tracks.length,
                    `"${k.key} ${k.scale}" shows ${k.plays} listens but returned no tracks`,
                ).toBeGreaterThan(0);
            }
        });

        await session.step("the core slice never promises more than it returns", async () => {
            const forHalf = allTime!.forHalf ?? 40;
            const res = await page.request.get(`/api/stats/tracks?of=core&limit=${forHalf}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const { tracks } = await res.json();
            expect(tracks.length).toBeGreaterThan(0);
            expect(tracks.length).toBeLessThanOrEqual(Math.min(forHalf, 100));
        });

        await session.step("a nonsense limit is refused, not answered with everything", async () => {
            const res = await page.request.get(`/api/stats/tracks?of=top&limit=abc`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), "a bad limit should not be a server error").toBe(200);
            const { tracks } = await res.json();
            expect(tracks.length, "and must not sail past the cap").toBeLessThanOrEqual(100);
        });

        await session.step("pressing play on a top track starts audio", async () => {
            await page.goto("/stats");
            await settle(page);
            const trackRow = page.locator('main ol li button[aria-label^="Play "]').first();
            await expect(trackRow).toBeVisible({ timeout: 15_000 });
            await trackRow.click();

            // The player is an <audio> element and is never visible. What
            // matters is that it got a source and started moving.
            await expect
                .poll(
                    async () =>
                        page.$eval(PLAYER, (el) => {
                            const a = el as HTMLAudioElement;
                            return a.src ? (a.paused ? "paused" : "playing") : "no source";
                        }).catch(() => "missing"),
                    { timeout: 25_000, message: "pressing play on a top track should start audio" },
                )
                .toBe("playing");

            const src = await page.$eval(PLAYER, (el) => (el as HTMLAudioElement).src);
            expect(src, "and the source should be a real stream URL").toContain("/stream");
            // Deliberately not asserting readyState: headless Chromium ships no
            // audio codec, so it reports HAVE_NOTHING however well the stream is
            // being served. `paused === false` plus a stream URL is the same bar
            // the main walkthrough uses.
        });

        session.assertClean("4. Playable slices");
    });

    test("5. the player states how many times you have heard this track", async () => {
        session.setJourney("5. Player play count");

        await session.step("the count in the bar is the count the API gives", async () => {
            const trackId = await page.evaluate(() => {
                try {
                    return JSON.parse(localStorage.getItem("kima_current_track") || "null")?.id ?? null;
                } catch {
                    return null;
                }
            });
            test.skip(!trackId, "nothing is playing to count");

            const res = await page.request.get(`/api/stats/track/${trackId}/plays`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const { plays } = await res.json();
            expect(typeof plays).toBe("number");

            // The bar says the ordinal of the play in progress, which is one
            // past the completed count. Silent on a first listen.
            if (plays >= 1) {
                const n = plays + 1;
                const suffix = n % 10 === 1 && n % 100 !== 11 ? "st"
                    : n % 10 === 2 && n % 100 !== 12 ? "nd"
                    : n % 10 === 3 && n % 100 !== 13 ? "rd"
                    : "th";
                const ordinal = new RegExp(`\\b${n}(${suffix}) play\\b`);
                await expect
                    .poll(async () => (await page.locator("body").innerText()).replace(/\s+/g, " "), {
                        timeout: 20_000,
                        message: `the player bar should state the ${n}${suffix} play`,
                    })
                    .toMatch(ordinal);

                // And it must link to the page the number came from.
                const link = page.getByRole("link", { name: ordinal });
                await expect(link).toHaveAttribute("href", "/stats");
            }
        });

        await session.step("an unknown track counts zero rather than erroring", async () => {
            const res = await page.request.get(`/api/stats/track/no-such-track/plays`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            expect((await res.json()).plays).toBe(0);
        });

        session.assertClean("5. Player play count");
    });

    test("6. the queue limit is a setting, and the server enforces it", async () => {
        session.setJourney("6. Queue limit");

        // Journeys 4-5 leave the player running. A playing page persists its
        // own queue on every auto-advance, which races this journey's API
        // probe and overwrites it (observed: probe saved 10025 -> clamped
        // 10000, then the live player's 8-track queue landed before the
        // read-back). Pause first so nothing writes during the probe.
        const pause = page.getByTitle("Pause", { exact: true });
        if (await pause.isVisible({ timeout: 2000 }).catch(() => false)) {
            await pause.click().catch(() => {});
            await settle(page, 1500);
        }

        await session.step("the server publishes the limit it will honour", async () => {
            const res = await page.request.get(`/api/playback-state/limit`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const { maxQueueLength } = await res.json();
            expect(maxQueueLength).toBeGreaterThanOrEqual(100);
            expect(maxQueueLength).toBeLessThanOrEqual(100_000);
        });

        await session.step("a queue longer than the limit is clamped, not rejected", async () => {
            const limitRes = await page.request.get(`/api/playback-state/limit`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const { maxQueueLength } = await limitRes.json();

            const oversized = Array.from({ length: maxQueueLength + 25 }, (_, i) => ({
                id: `probe-${i}`,
                title: `Probe ${i}`,
                duration: 180,
            }));
            const save = await page.request.post(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { playbackType: "track", queue: oversized, currentIndex: 0 },
            });
            expect(save.status(), "an over-long queue should be trimmed, not refused").toBe(200);

            const read = await page.request.get(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const state = await read.json();
            expect(Array.isArray(state.queue)).toBe(true);
            expect(state.queue.length).toBe(maxQueueLength);
        });

        await session.step("the queue is not being written to localStorage any more", async () => {
            // It was written on every change and read by nothing, which cost a
            // multi-megabyte stringify per skip and shared a try/catch with the
            // current track.
            const stored = await page.evaluate(() => localStorage.getItem("kima_queue"));
            expect(stored, "kima_queue should no longer be written").toBeNull();
        });

        await session.step("an admin can see the setting in Settings", async () => {
            await page.goto("/settings");
            await settle(page);
            const row = page.getByText(/queue limit/i).first();
            await expect(row).toBeVisible({ timeout: 15_000 });
        });

        session.assertClean("6. Queue limit");
    });

    test("7. the play-history audit reports honestly and deletes only what it proves", async () => {
        session.setJourney("7. Play history audit");

        let before: {
            totalListens: number;
            heard: number;
            skipped: number;
            tooShort: number;
            unclear: number;
            duplicateRows: number;
            collapsibleRows: number;
        };

        await session.step("the audit's figures add up to the listens it counted", async () => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            before = await res.json();
            expect(
                before.heard + before.skipped + before.tooShort + before.unclear,
                "the four buckets are read against 'times you pressed play' and must sum to it",
            ).toBe(before.totalListens);
        });

        await session.step("a track too short to ever count is never queued for deletion", async () => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const audit = await res.json();
            const onlyTooShort = audit.tracks.filter(
                (t: { skipped: number; tooShort: number }) => t.skipped === 0 && t.tooShort > 0,
            );
            expect(
                onlyTooShort.length,
                "being under thirty seconds is a fact about a track, not proof about a listen",
            ).toBe(0);
        });

        // The merge itself is exercised through its button in journey 7b, not
        // here. Doing it twice meant whichever ran first consumed the duplicates
        // and the other skipped — and the one that skipped was the one driving
        // the real interface.

        await session.step("the stats page still agrees after the merge", async () => {
            const res = await page.request.get(`/api/stats?tz=Europe/London&period=all`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const d = await res.json();
            expect(
                d.listening.plays,
                "the merge removes duplicate records, not listens",
            ).toBe(allTime!.plays);
        });

        await session.step("the panel renders what the API said", async () => {
            await page.goto("/stats#false-starts");
            await settle(page);

            // The audit reads the whole history, so it is deliberately lazy —
            // "nothing runs until you ask". Asking is part of the journey.
            const ask = page.getByRole("button", { name: /look for false starts/i });
            if (await ask.isVisible().catch(() => false)) await ask.click();

            await expect(page.getByText(/times you pressed play/i).first()).toBeVisible({
                timeout: 30_000,
            });

            // The four buckets on screen must be the four the API returned, or
            // the panel is describing a different history than the one audited.
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const audit = await res.json();
            const shown = (await page.locator("main").innerText()).replace(/\s+/g, " ");
            expect(shown).toContain(audit.totalListens.toLocaleString());
            expect(shown).toContain(audit.heard.toLocaleString());
        });

        session.assertClean("7. Play history audit");
    });

    test("7b. the audit's buttons: merge, ignore, restore, remove", async () => {
        session.setJourney("7b. Audit buttons");

        /** The audit as the server currently sees it. */
        const audit = async () =>
            (
                await page.request.get(`/api/stats/false-starts`, {
                    headers: { Authorization: `Bearer ${token}` },
                })
            ).json();

        /** Every play row this user has, counted at the source. */
        const rowCount = async (): Promise<number> => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return (await res.json()).totalRows;
        };

        await session.step("open the panel and ask it to look", async () => {
            await page.goto("/stats#false-starts");
            await settle(page);
            const ask = page.getByRole("button", { name: /look for false starts/i });
            if (await ask.isVisible().catch(() => false)) await ask.click();
            await expect(page.getByText(/times you pressed play/i).first()).toBeVisible({
                timeout: 30_000,
            });
        });

        await session.step("the merge button removes exactly the number it names", async () => {
            const start = await audit();
            test.skip(start.collapsibleRows === 0, "nothing left to merge");

            const button = page.getByRole("button", { name: /merge [\d,]+ duplicate records/i });
            await expect(button).toBeVisible();
            const label = await button.innerText();
            const promised = Number(label.replace(/\D/g, ""));
            expect(
                promised,
                "the button must name the number of rows it will actually delete",
            ).toBe(start.collapsibleRows);

            const rowsBefore = await rowCount();
            await button.click();
            await expect(page.getByText(/merged [\d,]+ duplicate records/i)).toBeVisible({
                timeout: 60_000,
            });

            const rowsAfter = await rowCount();
            expect(
                rowsBefore - rowsAfter,
                "the rows that disappeared must be the rows it promised",
            ).toBe(promised);

            const end = await audit();
            expect(end.totalListens, "a merge changes records, never listens").toBe(
                start.totalListens,
            );
            expect(end.heard, "and must not destroy the evidence behind 'proven heard'").toBe(
                start.heard,
            );
        });

        await session.step("leaving a track alone removes nothing and takes it off the list", async () => {
            await page.reload();
            await settle(page);
            const ask = page.getByRole("button", { name: /look for false starts/i });
            if (await ask.isVisible().catch(() => false)) await ask.click();
            await expect(page.getByText(/times you pressed play/i).first()).toBeVisible({
                timeout: 30_000,
            });

            const start = await audit();
            test.skip(start.tracks.length === 0, "the audit found nothing to act on");

            const rowsBefore = await rowCount();
            const firstBox = page.locator('main input[type="checkbox"]').first();
            await expect(firstBox).toBeVisible({ timeout: 15_000 });
            await firstBox.check();

            await page.getByRole("button", { name: /leave alone/i }).first().click();
            await expect(page.getByText(/ignoring \d+ track/i)).toBeVisible({ timeout: 30_000 });

            expect(
                await rowCount(),
                "'leave alone' must not delete a single row",
            ).toBe(rowsBefore);

            const end = await audit();
            expect(end.ignored.length, "and the track should now be listed as ignored").toBe(
                start.ignored.length + 1,
            );
        });

        await session.step("putting it back returns it to the audit", async () => {
            const start = await audit();
            test.skip(start.ignored.length === 0, "nothing is ignored");

            // The ignored list is collapsed by default, so expand it first. The
            // control inside reads "put back"; "Back in the audit." is the
            // message it shows afterwards.
            const reveal = page.getByRole("button", { name: /show \d+ ignored track/i });
            await expect(reveal).toBeVisible({ timeout: 15_000 });
            await reveal.click();

            const back = page.getByRole("button", { name: /put back/i }).first();
            await expect(back).toBeVisible({ timeout: 15_000 });
            const rowsBefore = await rowCount();
            await back.click();
            await expect
                .poll(async () => (await audit()).ignored.length, { timeout: 30_000 })
                .toBe(start.ignored.length - 1);
            expect(await rowCount(), "restoring must not touch any row either").toBe(rowsBefore);
        });

        await session.step("remove deletes the provable skips, and only those", async () => {
            await page.reload();
            await settle(page);
            const ask = page.getByRole("button", { name: /look for false starts/i });
            if (await ask.isVisible().catch(() => false)) await ask.click();
            await expect(page.getByText(/times you pressed play/i).first()).toBeVisible({
                timeout: 30_000,
            });

            const start = await audit();
            test.skip(start.skipped === 0, "the audit can prove nothing was skipped");

            const rowsBefore = await rowCount();

            const selectAll = page.getByRole("button", { name: /select all/i });
            await expect(selectAll).toBeVisible({ timeout: 15_000 });
            await selectAll.click();

            // The confirmation is deliberately two presses: a delete this size
            // should not happen on one click.
            const remove = page.getByRole("button", { name: /remove from \d+ track/i });
            await expect(remove).toBeVisible({ timeout: 15_000 });
            await remove.click();
            const confirm = page.getByRole("button", { name: /delete [\d,]+ listens\?/i });
            await expect(confirm, "a destructive action should ask before acting").toBeVisible({
                timeout: 15_000,
            });
            const promised = Number((await confirm.innerText()).replace(/\D/g, ""));
            await confirm.click();

            await expect(page.getByText(/removed [\d,]+ records/i)).toBeVisible({ timeout: 60_000 });

            const end = await audit();
            const rowsAfter = await rowCount();

            // The confirmation counts LISTENS; the table stores ROWS, and after a
            // merge a listen is still one or two rows. Comparing the promise to
            // the row delta compares different units — measured: it named 898
            // listens and removed 954 rows, and both figures were correct.
            expect(
                start.totalListens - end.totalListens,
                "the listens that went must be the listens it named",
            ).toBe(promised);
            expect(
                rowsBefore - rowsAfter,
                "and every deleted listen takes at least its own row with it",
            ).toBeGreaterThanOrEqual(promised);
            expect(
                end.heard,
                "a delete of provable skips must not take a proven-heard listen with it",
            ).toBe(start.heard);
            expect(
                end.tooShort,
                "nor a track that was only ever too short to count",
            ).toBe(start.tooShort);
            expect(end.skipped, "and the skips it proved should now be gone").toBeLessThan(
                start.skipped,
            );
        });

        session.assertClean("7b. Audit buttons");
    });

    test("7c. the queue limit setting is saved and honoured", async () => {
        session.setJourney("7c. Queue limit setting");

        await session.step("changing the number in Settings changes what the server keeps", async () => {
            const original = (
                await (
                    await page.request.get(`/api/playback-state/limit`, {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                ).json()
            ).maxQueueLength as number;

            await page.goto("/settings");
            await settle(page);

            const row = page.getByText(/queue limit/i).first();
            await expect(row).toBeVisible({ timeout: 20_000 });
            const input = page
                .locator("input[type=number]")
                .filter({ hasNot: page.locator("[disabled]") })
                .last();
            await input.fill("2500");
            await input.blur(); // the box commits on blur; there is no Save button for it

            await expect
                .poll(
                    async () =>
                        (
                            await (
                                await page.request.get(`/api/playback-state/limit`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                })
                            ).json()
                        ).maxQueueLength,
                    { timeout: 90_000, message: "the server should honour the saved limit" },
                )
                .toBe(2500);

            // And the clamp must follow the new number, not the old one.
            const oversized = Array.from({ length: 2600 }, (_, i) => ({
                id: `probe-${i}`,
                title: `Probe ${i}`,
                duration: 180,
            }));
            await page.request.post(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { playbackType: "track", queue: oversized, currentIndex: 0 },
            });
            const state = await (
                await page.request.get(`/api/playback-state`, {
                    headers: { Authorization: `Bearer ${token}` },
                })
            ).json();
            expect(state.queue.length).toBe(2500);

            // Put it back, so the suite leaves the instance as it found it.
            await page.request.post(`/api/system-settings`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { maxQueueLength: original },
            });
        });

        session.assertClean("7c. Queue limit setting");
    });

    test("8. on a phone: the same page, adapted rather than amputated", async () => {
        session.setJourney("8. Phone");

        await session.step("nothing scrolls sideways at 390px", async () => {
            const phone = await browser.newContext({
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true,
            });
            const p = await phone.newPage();
            session.setActivePage(p);
            session.attach(p);
            try {
                await p.goto(`${baseUrl}/login`);
                await p.locator("#username").fill(username);
                await p.locator("#password").fill(password);
                await p.getByRole("button", { name: /sign in/i }).click();
                await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
                await p.goto(`${baseUrl}/stats`);
                await settle(p);

                const overflow = await p.evaluate(
                    () => document.documentElement.scrollWidth > window.innerWidth,
                );
                expect(overflow, "a phone must not scroll sideways").toBe(false);

                // The period control has to be reachable on a phone too, or a
                // narrow window is a trap with no way out.
                await expect(p.getByRole("button", { name: "30 days", exact: true })).toBeVisible();
            } finally {
                session.setActivePage(page);
                await phone.close();
            }
        });

        session.assertClean("8. Phone");
    });
});
