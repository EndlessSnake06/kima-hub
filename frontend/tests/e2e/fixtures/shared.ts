/** Constants and helpers every spec can import; nothing here reads the environment. */
import type { Page } from "@playwright/test";

/** CSS selector for the main audio element. */
export const PLAYER = '[data-kima-player="main"]';

/** Makes a literal string safe inside a RegExp used as an accessible-name filter. */
export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Headless Chromium has no WebGL and the vibe map needs it; these flags turn on software rendering. */
export const softwareWebGL = {
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
};

/**
 * Waits for the app to settle. networkidle never fires because the app holds a
 * server-sent-events stream open, so this waits for the DOM and then lets React paint.
 */
export async function settle(page: Page, ms = 800): Promise<void> {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(ms);
}
