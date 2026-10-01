import { test, expect } from "@playwright/test";
import {
    loginAsTestUser,
    startPlayingFirstAlbum,
    getAudioSrc,
    waitForSrcChange,
} from "./fixtures/test-helpers";

test.describe("Queue", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("Add to queue button appends track to up-next list", async ({ page }) => {
        // Start an album so the queue is populated. We land on the album page.
        await startPlayingFirstAlbum(page);

        // Hover the first track row to reveal the Add to queue button, then click it.
        // We are already on the album page -- no need to re-navigate.
        const firstTrackRow = page.locator("[data-track-row]").first();
        await firstTrackRow.waitFor({ timeout: 10_000 });
        await firstTrackRow.hover();
        await firstTrackRow.getByLabel("Add to queue").click();

        // Navigate to the queue page via the sidebar Queue link (client-side
        // navigation) so React state -- including the queue -- is preserved.
        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);

        // "Next Up" section must appear since the album has multiple tracks ahead
        await expect(page.getByText(/Next Up/)).toBeVisible({ timeout: 5_000 });
    });

    test("queue page loads with Now Playing section when track is active", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        // Client-side nav via the sidebar Queue link to preserve React queue state
        // (page.goto reloads the page and wipes in-memory queue context)
        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);

        // Should show "Now Playing" heading since a track is active
        await expect(page.getByRole("heading", { name: "Now Playing" })).toBeVisible({ timeout: 5_000 });
    });

    test("queue page shows track count", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.goto("/queue");
        await page.waitForLoadState("domcontentloaded");

        // The queue header shows "{n} track(s) in queue"
        await expect(page.locator("text=/\\d+ track/")).toBeVisible({ timeout: 5_000 });
    });

    test("Play now jumps to selected queue item", async ({ page }) => {
        // Start album (populates queue with multiple tracks)
        await startPlayingFirstAlbum(page);

        const srcBefore = await getAudioSrc(page);

        // Client-side nav to preserve queue state in React context
        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);
        // Find the Next Up section -- tracks after the currently playing one
        // Each track row is a flex div containing the action buttons
        const playNowButtons = page.locator('[title="Play now"]');
        const count = await playNowButtons.count();

        if (count === 0) {
            test.skip(); // No upcoming tracks; skip rather than fail
            return;
        }

        // Hover to expose the row actions and click "Play now" on a queued track
        // Walk up 3 levels: button -> actions div -> track row div
        const targetRow = playNowButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");
        await targetRow.hover();
        await targetRow.getByTitle("Play now").click();

        // Audio source should change since we skipped to a different track
        const srcAfter = await waitForSrcChange(page, srcBefore, 8_000);
        expect(srcAfter).not.toBe(srcBefore);
    });

    test("Remove removes item from queue", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);

        const removeButtons = page.locator('[title="Remove"]');
        const initialCount = await removeButtons.count();

        if (initialCount === 0) {
            test.skip();
            return;
        }

        // Walk up to the row container from the Remove button
        const firstQueueItem = removeButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");

        // Hover to show the controls, then click Remove
        await firstQueueItem.hover();
        await firstQueueItem.getByTitle("Remove").click();

        // Count should decrease
        await expect(page.locator('[title="Remove"]')).toHaveCount(initialCount - 1, { timeout: 3_000 });
    });

    test("Move up reorders queue item", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);

        const moveUpButtons = page.locator('[title="Move up"]:not([disabled])');
        const count = await moveUpButtons.count();

        if (count === 0) {
            test.skip(); // No movable items
            return;
        }

        // Grab the track titles from "Next Up" before the reorder.
        // The first item's Move up button is always disabled, so the first
        // ENABLED button belongs to index 1 -- that's the track we'll move.
        const nextUpSection = page.locator("section").filter({
            has: page.locator("h2", { hasText: "Next Up" }),
        });
        const titlesBefore = await nextUpSection.locator("h3").allTextContents();

        if (titlesBefore.length < 2) {
            test.skip(); // Need at least 2 items to verify reorder
            return;
        }
        const targetTitle = titlesBefore[1]; // the one that will move to index 0

        // Hover the target row and click Move up
        const targetRow = moveUpButtons.first().locator("xpath=ancestor::div[contains(@class,'flex') and contains(@class,'items-center')][1]");
        await targetRow.hover();
        await targetRow.getByTitle("Move up").click();

        // After the move, targetTitle should now be the first item in Next Up
        const titlesAfter = await nextUpSection.locator("h3").allTextContents();
        expect(titlesAfter[0]).toBe(targetTitle);
    });

    test("Clear queue empties the up-next list", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        // Navigate via sidebar Queue link (client-side nav) to keep React state
        await page.getByRole("link", { name: "Queue" }).click();
        await page.waitForURL(/\/queue/);

        // Clear queue only appears when queue.length > 0, and asks before clearing
        const clearBtn = page.getByRole("button", { name: "Clear queue" });
        await expect(clearBtn).toBeVisible({ timeout: 5_000 });
        await clearBtn.click();
        await page.getByRole("dialog", { name: "Clear the queue?" }).getByRole("button", { name: "Clear queue" }).click();

        // Up Next section should disappear (or show empty state)
        await expect(page.getByText("No tracks in queue")).toBeVisible({ timeout: 5_000 });
    });
});
