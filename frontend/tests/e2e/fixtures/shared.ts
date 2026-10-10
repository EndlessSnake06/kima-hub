/** Constants and helpers every spec can import; nothing here reads the environment. */

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
