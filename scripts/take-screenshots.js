#!/usr/bin/env node
/**
 * Takes README screenshots against a running Kima instance. From frontend/:
 * KIMA_TEST_USERNAME=… KIMA_TEST_PASSWORD=… node ../scripts/take-screenshots.js
 * (KIMA_UI_BASE_URL defaults to http://127.0.0.1:3030).
 */

const { chromium } = require("playwright");
const path = require("path");

const BASE_URL = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const USERNAME = process.env.KIMA_TEST_USERNAME;
const PASSWORD = process.env.KIMA_TEST_PASSWORD;
const OUT_DIR = path.resolve(__dirname, "../assets/screenshots");

if (!USERNAME || !PASSWORD) {
    console.error("Set KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD before running.");
    process.exit(1);
}

async function shot(page, filename) {
    const outPath = path.join(OUT_DIR, filename);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  [ok] ${filename}`);
}

async function netIdle(page, ms = 5000) {
    try {
        await page.waitForLoadState("networkidle", { timeout: ms });
    } catch { /* ok */ }
}

async function login(page) {
    await page.goto(`${BASE_URL}/login`);
    await page.locator("#username").fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
    console.log(`  logged in as ${USERNAME}`);
}

async function startPlaying(page) {
    await page.goto(`${BASE_URL}/collection?tab=albums`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    const firstAlbum = page.locator('a[href^="/album/"]').first();
    await firstAlbum.waitFor({ timeout: 8000 });
    await firstAlbum.click();
    await page.waitForURL(/\/album\//, { timeout: 8000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
    await page.getByLabel("Play all").click();
    await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
}

async function takeDesktopShots(browser) {
    console.log("\nDesktop (1440x900)...");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await login(p);

    // Home
    await p.goto(`${BASE_URL}/`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "desktop-home.png");

    // Library - albums tab
    await p.goto(`${BASE_URL}/collection?tab=albums`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "desktop-library.png");

    // Album page
    try {
        const link = p.locator('a[href^="/album/"]').first();
        await link.waitFor({ timeout: 8000 });
        await link.click();
        await p.waitForURL(/\/album\//, { timeout: 8000 });
        await p.waitForLoadState("domcontentloaded");
        await netIdle(p, 4000);
        await p.waitForTimeout(1500);
        await shot(p, "desktop-album.png");
    } catch (e) {
        console.warn("  [skip] desktop-album.png:", e.message);
    }

    // Artist page
    await p.goto(`${BASE_URL}/collection?tab=artists`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    try {
        const link = p.locator('a[href^="/artist/"]').first();
        await link.waitFor({ timeout: 8000 });
        await link.click();
        await p.waitForURL(/\/artist\//, { timeout: 8000 });
        await p.waitForLoadState("domcontentloaded");
        await netIdle(p, 4000);
        await p.waitForTimeout(1500);
        await shot(p, "desktop-artist.png");
    } catch (e) {
        console.warn("  [skip] desktop-artist.png:", e.message);
    }

    // Podcasts
    await p.goto(`${BASE_URL}/podcasts`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "desktop-podcasts.png");

    // Audiobooks
    await p.goto(`${BASE_URL}/audiobooks`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "desktop-audiobooks.png");

    // Player (start music then screenshot)
    try {
        await startPlaying(p);
        await shot(p, "desktop-player.png");
    } catch (e) {
        console.warn("  [skip] desktop-player.png:", e.message);
    }

    // Settings
    await p.goto(`${BASE_URL}/settings`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 4000);
    await p.waitForTimeout(1500);
    await shot(p, "desktop-settings.png");

    // Deezer browse
    await p.goto(`${BASE_URL}/browse/playlists`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 8000);
    await p.waitForTimeout(2000);
    await shot(p, "deezer-browse.png");

    // Import / playlist
    await p.goto(`${BASE_URL}/import/playlist`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 4000);
    await p.waitForTimeout(1500);
    await shot(p, "spotify-import-preview.png");

    // Mood Mixer (home page, scroll to it)
    await p.goto(`${BASE_URL}/`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    try {
        // Look for mood mixer heading or the MoodMixer component
        const moodSection = p.locator("text=Mood Mixer, text=Create Your Vibe, text=Mood").first();
        if (await moodSection.isVisible({ timeout: 3000 })) {
            await moodSection.scrollIntoViewIfNeeded();
            await p.waitForTimeout(500);
        } else {
            // Scroll down ~600px from the top to reveal sections below the fold
            await p.evaluate(() => window.scrollBy(0, 600));
            await p.waitForTimeout(500);
        }
    } catch { /* ignore */ }
    await shot(p, "mood-mixer.png");

    // --- Vibe (nebula map, 3D) ---

    await p.goto(`${BASE_URL}/vibe`);
    await p.waitForLoadState("domcontentloaded");
    console.log("  waiting for vibe canvas (up to 40s)...");
    const canvas = p.locator("canvas").first();
    const noData = p.locator("text=/No tracks with vibe analysis|Charting your library/i").first();
    try {
        await Promise.race([
            canvas.waitFor({ timeout: 40_000 }),
            noData.waitFor({ timeout: 40_000 }),
        ]);
    } catch { /* ok */ }
    await p.waitForTimeout(6000); // let the nebula settle and stars fade in
    await shot(p, "vibe-map.png");

    // Search highlight
    try {
        await p.getByLabel("Search tracks or artists").click();
        await p.getByLabel("Search tracks or artists").fill("the");
        await p.waitForTimeout(2500);
        await shot(p, "vibe-search.png");
        await p.getByLabel("Clear search").click();
    } catch (e) {
        console.warn("  [skip] vibe-search.png:", e.message);
    }

    // Song Path panel
    try {
        await p.getByLabel("Song Path: build a queue that glides from one track to another").click();
        await p.waitForTimeout(1500);
        await shot(p, "vibe-songpath.png");
        await p.keyboard.press("Escape");
        await p.waitForTimeout(500);
    } catch (e) {
        console.warn("  [skip] vibe-songpath.png:", e.message);
    }

    // Blend panel
    try {
        await p.getByLabel("Blend: mix tracks you like (and ones you don't) into a new playlist").click();
        await p.waitForTimeout(1500);
        await shot(p, "vibe-blend.png");
        await p.keyboard.press("Escape");
    } catch (e) {
        console.warn("  [skip] vibe-blend.png:", e.message);
    }

    // --- Stats (new in 1.11) ---
    await p.goto(`${BASE_URL}/stats`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(2500);
    await shot(p, "desktop-stats.png");

    // --- Discover / similar artists (new in 1.11) ---
    await p.goto(`${BASE_URL}/discover`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 8000);
    await p.waitForTimeout(2500);
    await shot(p, "desktop-discover.png");

    await ctx.close();
}

async function takeMobileShots(browser) {
    console.log("\nMobile (390x844)...");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await login(p);

    // Mobile Home
    await p.goto(`${BASE_URL}/`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "mobile-home.png");

    // Mobile Library
    await p.goto(`${BASE_URL}/collection?tab=albums`);
    await p.waitForLoadState("domcontentloaded");
    await netIdle(p, 6000);
    await p.waitForTimeout(1500);
    await shot(p, "mobile-library.png");

    // Mobile Player
    try {
        await startPlaying(p);
        await shot(p, "mobile-player.png");
    } catch (e) {
        console.warn("  [skip] mobile-player.png:", e.message);
    }

    await ctx.close();
}

async function main() {
    console.log(`Taking screenshots against ${BASE_URL}`);
    console.log(`Saving to ${OUT_DIR}\n`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--disable-dev-shm-usage",
        ],
    });

    try {
        await takeDesktopShots(browser);
        await takeMobileShots(browser);
    } finally {
        await browser.close();
    }

    console.log("\nDone.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
