// The ambient baseline's wayfinding zones -- fixed regions of the CLIENT-SIDE 10k
// field. Shared by the region labels, the scene's fly-to, and the baseline search /
// explore chips. These are DECORATIVE map regions of the deterministic field (like
// the rig's mood sectors) -- NOT per-person data, never counted, and they need NO
// backend: the field + its zones are seeded the same every render. Dots use the deep
// low-chroma mood palette (never the amber accent).

export interface GalaxyZone {
    id: string;
    name: string;
    /** angle (radians) of the zone's centroid around the field center */
    a: number;
    /** deep low-chroma mood dot for the search row + label accent */
    dot: string;
}

/** Radius of the zone ring on the ambient field (matches RegionLabels). */
const ZONE_RADIUS = 44;

// Dots ARE the app's mood tokens, expressed as sRGB hex because they're also fed to
// three.js material colors (the Reticle), which can't read a CSS `var()`. Each value
// is the sRGB of the matching --color-mood-* OKLCH token in globals.css, so the zones
// stay on the one deep low-chroma palette instead of ad-hoc hex.
export const GALAXY_ZONES: GalaxyZone[] = [
    { id: "nightdrive", name: "Nightdrive", a: 0.6, dot: "#7b63a3" }, // --electronic
    { id: "emberfolk", name: "Emberfolk", a: 0.6 + Math.PI / 2, dot: "#b19270" }, // --acoustic
    { id: "deep-currents", name: "Deep Currents", a: 0.6 + Math.PI, dot: "#529796" }, // --relaxed
    { id: "afterglow", name: "Afterglow", a: 0.6 + (3 * Math.PI) / 2, dot: "#b65e8b" }, // --party
];

/** World position (x,y,z) of a zone's centroid on the ambient field. */
export function zoneWorldPos(zone: GalaxyZone, radius = ZONE_RADIUS): [number, number, number] {
    return [Math.cos(zone.a) * radius, 0, Math.sin(zone.a) * radius];
}

/** Smallest absolute angular distance (radians) for an angle delta. */
function angularDistance(delta: number): number {
    const d = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
}

/** Which zone (0-based index) owns a field angle -- the nearest zone centroid. Assigns
 *  each ambient baseline star to a sector for the explore-a-vibe glow. */
export function zoneIndexForAngle(angle: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < GALAXY_ZONES.length; i++) {
        const d = angularDistance(angle - GALAXY_ZONES[i].a);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

