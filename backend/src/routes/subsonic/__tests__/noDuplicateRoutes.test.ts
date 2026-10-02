/**
 * No Subsonic path is registered twice. Express runs the first match, so a
 * second registration is dead code that looks live, and the shadowed one was
 * often the working implementation.
 */

import fs from "fs";
import path from "path";

// Mount order from subsonic/index.ts. Listed explicitly so that adding a router
// there without adding it here shows up as an untested file rather than
// silently escaping the check.
const ROUTER_FILES = [
    "compat.ts",
    "library.ts",
    "playback.ts",
    "search.ts",
    "playlists.ts",
    "queue.ts",
    "starred.ts",
    "artistInfo.ts",
    "lyrics.ts",
    "userManagement.ts",
    "profile.ts",
    "podcasts.ts",
];

const SUBSONIC_DIR = path.join(__dirname, "..");

function registeredPaths(file: string): string[] {
    const source = fs.readFileSync(path.join(SUBSONIC_DIR, file), "utf8");
    const found: string[] = [];
    // Matches `xRouter.all("/foo.view"` and `xRouter.all(["/a.view", "/b.view"]`
    const call = /Router\.(?:all|get|post)\(\s*(\[[^\]]*\]|"[^"]*")/g;
    let m: RegExpExecArray | null;
    while ((m = call.exec(source)) !== null) {
        for (const p of m[1].match(/"([^"]+)"/g) ?? []) {
            const clean = p.slice(1, -1);
            if (clean.endsWith(".view")) found.push(clean);
        }
    }
    return found;
}

describe("subsonic route registration", () => {
    it("every router file in the mount list exists", () => {
        for (const file of ROUTER_FILES) {
            expect(fs.existsSync(path.join(SUBSONIC_DIR, file))).toBe(true);
        }
    });

    it("registers no path more than once across all routers", () => {
        const owners = new Map<string, string[]>();
        for (const file of ROUTER_FILES) {
            for (const p of registeredPaths(file)) {
                owners.set(p, [...(owners.get(p) ?? []), file]);
            }
        }

        const duplicated = [...owners.entries()]
            .filter(([, files]) => files.length > 1)
            .map(([p, files]) => `${p} registered in ${files.join(" and ")}`);

        // A duplicate means one of the two is unreachable. Whichever mounts
        // first in subsonic/index.ts wins, which is rarely the one intended.
        expect(duplicated).toEqual([]);
    });

    it("finds a meaningful number of routes, so a broken matcher fails loudly", () => {
        const total = ROUTER_FILES.reduce(
            (n, f) => n + registeredPaths(f).length,
            0
        );
        expect(total).toBeGreaterThan(50);
    });
});
