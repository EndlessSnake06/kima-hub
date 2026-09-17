import { defineConfig } from "@playwright/test";

/**
 * Testbed dogfood config — fresh-install gate for the single production image.
 *
 * Differences from playwright.config.ts:
 *   - NO globalSetup: the whole point is registering the account through the
 *     real onboarding UI on a fresh database. The default globalSetup logs in
 *     as a pre-provisioned user, which cannot exist yet.
 *   - launchArgs: deck.gl (vibe map) needs software GL in headless Chromium.
 */
const baseURL = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3055";

export default defineConfig({
    testDir: "./tests/e2e/dogfood",
    timeout: 120 * 60_000, // journey 4 (enrichment watch) alone can take ~an hour
    expect: { timeout: 30_000 },
    retries: 0, // a gate that retries itself is not a gate
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        launchOptions: {
            args: ["--use-gl=angle", "--use-angle=swiftshader"],
        },
    },
    reporter: [["list"], ["html", { open: "never" }]],
});
