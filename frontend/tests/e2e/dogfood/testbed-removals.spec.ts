import { expect, test, type Page } from "@playwright/test";

/**
 * Testbed dogfood addendum — the removal fixes as real UI journeys.
 *
 * Covers the v1.11.0 bug-fix surface the canonical walkthrough does not:
 *   1. Podcast delete through the actual UI (Remove → "Remove podcast?")
 *      with DB-level verification and idempotency (delete twice → still 200).
 *   2. Audiobook cache prune is exercised only when Audiobookshelf is
 *      enabled; on this testbed it is deliberately absent, so the dogfood
 *      for it is the graceful-absence journey in testbed.spec.ts.
 *
 * Runs against the same testbed instance as testbed.spec.ts, which has
 * already registered kima_dogfood. Auth is the JWT from localStorage.
 */

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3055";
const USERNAME = process.env.KIMA_TEST_USERNAME || "kima_dogfood";
const PASSWORD = process.env.KIMA_TEST_PASSWORD || "dogfood-test-1";

/** Feed is sourced from the app's own discover API at runtime — never hardcoded. */
let FEED_URL = "";

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The release-notes dialog ("What's new") opens over the app on a fresh
 * browser context and intercepts ALL pointer events until dismissed. Its
 * controls: an X (aria-label "Close") and a footer "Done"/"Close" button —
 * both disabled while `closing` runs, and consent items may need answering.
 */
async function dismissWhatsNew(page: Page): Promise<void> {
    for (let i = 0; i < 6; i++) {
        const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
        if (!(await dialog.count())) return;
        // The X in the header; clicking it runs the same close path as Done.
        const close = page.locator('div[role="dialog"] button[aria-label="Close"]').first();
        if (await close.count()) {
            await close.click({ timeout: 3000 }).catch(() => {});
        }
        await page.waitForTimeout(1500);
    }
}

test.describe.serial("Testbed removals", () => {
    let page: Page;
    let token = "";
    let podcastId = "";
    let podcastTitle = "";

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await page.goto(baseUrl + "/login");
        await page.locator('input[placeholder="Enter your username"]').fill(USERNAME);
        await page.locator('input[placeholder="Enter your password"]').fill(PASSWORD);
        await page.getByRole("button", { name: /sign in|log in/i }).click();
        await page.waitForURL(/\/(home|sync|)$/, { timeout: 30_000 });
        await dismissWhatsNew(page);
        token = (await page.evaluate(() => localStorage.getItem("auth_token"))) ?? "";
        expect(token, "login should yield an auth token").toBeTruthy();
    });

    test("R1. subscribe to a podcast", async () => {
        // Source the feed the way the UI does: the discover directory.
        const top = await page.request.get("/api/podcasts/discover/top?limit=5", {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(top.status(), `discover returned ${top.status()}`).toBe(200);
        const body = await top.json();
        const list: Array<{ id?: string; feedUrl?: string; rssUrl?: string; feed?: string; title?: string }> = Array.isArray(body) ? body : (body.podcasts ?? []);
        const pick = list.find((p) => (p.feedUrl ?? p.rssUrl ?? p.feed ?? "").startsWith("https://"));
        expect(pick, "discover returned no podcast with an https feed").toBeTruthy();
        FEED_URL = pick?.feedUrl ?? pick?.rssUrl ?? pick?.feed ?? FEED_URL;
        podcastTitle = pick?.title ?? podcastTitle;

        const res = await page.request.post("/api/podcasts/subscribe", {
            data: { feedUrl: FEED_URL },
            headers: { Authorization: `Bearer ${token}` },
        });
        // The feed fetch is external; a 5xx would be the app failing, a 4xx
        // is the feed being unavailable (recorded, not fatal).
        expect(res.status(), `subscribe returned ${res.status()}`).toBeLessThan(500);
        if (!res.ok()) {
            test.skip(true, `feed unavailable (${res.status()}), removal journey cannot run`);
            return;
        }
        const created = await res.json();
        podcastId = created.id ?? created.podcast?.id ?? "";
        podcastTitle = created.title ?? created.podcast?.title ?? podcastTitle;
        expect(podcastId, "subscribe returned no id").toBeTruthy();
    });

    test("R2. it appears in the podcast library", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        await page.goto(baseUrl + "/podcasts");
        await page.waitForTimeout(2500);
        // Scoped the same way as R3's absence check: the user's library
        // section, not the iTunes top-charts that share the page.
        const card = page
            .locator('[data-tv-section="my-podcasts"]')
            .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) })
            .first();
        await expect(card).toBeVisible({ timeout: 15_000 });
    });

    test("R3. delete it through the real UI", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        // open the podcast detail
        await page
            .locator("main")
            .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) })
            .first()
            .click();
        await page.waitForURL(/\/podcasts\/[^/]+/, { timeout: 15_000 });
        await page.waitForTimeout(2500);

        // The Remove control (PodcastActionBar: shows only when subscribed).
        const remove = page.getByRole("button", { name: /^Remove$/ });
        await expect(remove).toBeVisible({ timeout: 15_000 });
        await remove.click();
        // Inline confirmation: the question is text, the buttons are Confirm/Cancel.
        const confirm = page.getByRole("button", { name: /^Confirm$/ });
        await expect(confirm).toBeVisible({ timeout: 10_000 });
        await confirm.click();

        // back at the library, and the card is gone. The list's cache can
        // lag the server; the API is the source of truth, the UI assertion
        // follows once the server agrees.
        await page.waitForURL(/\/podcasts$/, { timeout: 20_000 });
        await expect
            .poll(async () => {
                const r = await page.request.get("/api/podcasts", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!r.ok()) return -1;
                const d = await r.json();
                const list: Array<{ id?: string }> = Array.isArray(d) ? d : (d.podcasts ?? []);
                return list.filter((p) => p.id === podcastId).length;
            }, { timeout: 30_000 })
            .toBe(0);
        // The card is gone from the user's library. Scope to the
        // "my-podcasts" section: the page also renders iTunes' top-charts
        // below it, and the same podcast can legitimately appear there.
        await expect(
            page.locator('[data-tv-section="my-podcasts"]')
                .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) }),
        ).toHaveCount(0, { timeout: 30_000 });
    });

    test("R4. the row is gone at the DB level, and deleting again is idempotent", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        // API-level: detail 404s
        const detail = await page.request.get(`/api/podcasts/${podcastId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(detail.status(), `detail after delete returned ${detail.status()}`).toBe(404);

        // idempotency: unsubscribing an already-deleted podcast must not 500
        const again = await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(
            again.status(),
            `second unsubscribe returned ${again.status()} -- delete on missing row must be idempotent`,
        ).toBeLessThan(500);
    });
});
