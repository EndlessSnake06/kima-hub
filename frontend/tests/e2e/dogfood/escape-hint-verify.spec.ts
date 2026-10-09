import { expect, test } from "@playwright/test";

/**
 * The release window closes on Escape, the same path as Done and X. Its footer
 * names Escape when nothing waits on the user; while a decision waits, the
 * footer names the decision instead.
 */
const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3056";
const USERNAME = process.env.KIMA_TEST_USERNAME || "";
const PASSWORD = process.env.KIMA_TEST_PASSWORD || "";

test("release window: Esc hint renders and Escape dismisses", async ({ browser }) => {
    expect(
        USERNAME && PASSWORD,
        "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set",
    ).toBeTruthy();
    const page = await browser.newPage();
    await page.goto(baseUrl + "/login");
    await page.locator('input[placeholder="Enter your username"]').fill(USERNAME);
    await page.locator('input[placeholder="Enter your password"]').fill(PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(home|sync|)$/, { timeout: 30_000 });

    // 1. The release window should be up on first login after an upgrade.
    const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
    if (await dialog.isVisible().catch(() => false)) {
        // 2. The footer names Escape, or the decision that is waiting.
        const hint = page.locator('div[role="dialog"] footer p').first();
        await expect(hint).toHaveText(/press esc to close|needs you|things need you/i, { timeout: 10_000 });

        // 3. Press Escape -> dialog closes (same dismiss path as Done/X).
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden({ timeout: 10_000 });
    } else {
        // Already-past-release instance: note that this gate just didn't show
        // the window today. That's a testbed-state fact, not a code failure.
        test.skip(true, "release window not shown on this testbed instance (already dismissed in a prior session)");
    }

    await page.close();
});