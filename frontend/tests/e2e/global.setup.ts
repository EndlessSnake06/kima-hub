/**
 * Playwright global setup -- runs once before all tests.
 *
 * Verifies the E2E test user exists and can authenticate.
 * If login fails with the configured credentials, prints setup instructions and aborts.
 *
 * Required env vars (set in .env.test or export before running):
 *   KIMA_TEST_USERNAME  -- username of the dedicated E2E test user
 *   KIMA_TEST_PASSWORD  -- password of the dedicated E2E test user
 *   KIMA_UI_BASE_URL    -- base URL of the running app (default: http://127.0.0.1:3030)
 */
import { chromium } from "@playwright/test";

async function globalSetup(): Promise<void> {
    const username = process.env.KIMA_TEST_USERNAME;
    const password = process.env.KIMA_TEST_PASSWORD;
    const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";

    if (!username || !password) {
        throw new Error(
            "E2E test user credentials not set.\n" +
            "Set KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD in .env.test or export them before running E2E tests.\n" +
            "To create a test user, run: bash scripts/create-e2e-user.sh"
        );
    }

    // Verify the test user can log in via browser (also saves auth state)
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        await page.goto(`${baseUrl}/login`);
        await page.locator("#username").fill(username);
        await page.locator("#password").fill(password);
        await page.getByRole("button", { name: "Sign In" }).click();

        // Wait for redirect to the home page (matches /, /?..., /home)
        // Same pattern used by loginAsTestUser in test-helpers.ts
        try {
            await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
        } catch {
            const url = page.url();
            throw new Error(
                `Login failed for E2E test user '${username}'. Still on: ${url}\n` +
                "Create the user by running: bash scripts/create-e2e-user.sh"
            );
        }

        // Dismiss any pending What's New releases server-side, so the modal
        // cannot mount over tests (aria-modal intercepts all pointer events).
        // Best-effort: an empty pending list or a versioned endpoint that moved
        // must not fail setup.
        try {
            const { releases } = await page.evaluate(async () => {
                const res = await fetch("/api/whats-new/pending", { credentials: "include" });
                if (!res.ok) return { releases: [] };
                return res.json();
            });
            // Dismissing the first release advances the pending queue to the
            // next unseen one, so loop until the queue is actually empty.
            for (let i = 0; i < 10 && (releases?.length ?? 0) > 0; i++) {
                await page.evaluate(async (v) => {
                    await fetch(`/api/whats-new/${v}/dismiss`, {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: "{}",
                    });
                }, releases[0].version);
                const again = await page.evaluate(async () => {
                    const res = await fetch("/api/whats-new/pending", { credentials: "include" });
                    return res.ok ? res.json() : { releases: [] };
                });
                releases.splice(0, releases.length, ...(again.releases ?? []));
            }
            if (releases?.length) console.log(`[setup] Dismissed ${releases.length} pending What's New release(s).`);
        } catch {
            console.log("[setup] What's New pre-dismiss skipped (endpoint unavailable).");
        }

        await page.context().storageState({ path: "tests/e2e/.auth/user.json" });
        console.log(`[setup] E2E test user '${username}' verified, auth state saved.`);
    } finally {
        await browser.close();
    }
}

export default globalSetup;
