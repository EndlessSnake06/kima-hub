// Label placement for the galaxy view — the part that stopped piling up.
//
// A camera dive surfaced a neighbourhood of tracks; rendering each one at a
// fixed offset produced the "15 songs jumbled together".
// Instead we pick a SMALL, PRIORITY-ORDERED subset (never more than
// `maxLabels`) and drop any that would overlap one already placed, tested in
// SCREEN space. The candidate list is handed in ALREADY ordered (highest
// priority first); the greedy pass is therefore order-preserving. The geometry
// is untouched — only which labels survive — so draw calls stay flat at any
// track count.
//
// Pure: `project` maps a world label centre to device NDC coordinates
// ([-1,1]^2, y-up) using the active camera. The scene wires a real projection;
// tests pass a stub. No three.js state leaks in here.
import { measureLabelWidth, LABEL_PAD_X } from "./measureLabel";

/** Max labels that render at once (selection > hover > playing > nearest). */
export const MAX_LABELS = 5;

/** A track label candidate, in world coordinates (with its +offset). */
export interface LabelCandidate {
    world: [number, number, number];
    name: string;
}

/**
 * Return the candidate indices that render, highest-priority first.
 *
 * A candidate is skipped when it projects just outside the view frustum
 * (behind the camera or off-screen); then placed unless its measured pill
 * rect would intersect an already-placed one, until `maxLabels` are placed.
 * Indices refer to positions in the incoming `candidates` array, in input
 * order, so a downstream map can render them stably.
 *
 * The pill is assumed centred on `project(world)`; its horizontal extent is
 * `measureLabelWidth + LABEL_PAD_X` and vertical extent is `LABEL_HEIGHT`.
 */
export function resolveLabels(
    candidates: readonly LabelCandidate[],
    project: (w: [number, number, number]) => [number, number],
    viewportW: number,
    viewportH: number,
    maxLabels = MAX_LABELS,
): number[] {
    const out: number[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const tol = 1.05; // tiny overshoot tolerance for on-frustum edges

    for (let i = 0; i < candidates.length && out.length < maxLabels; i++) {
        const ndc = project(candidates[i].world);
        if (Math.abs(ndc[0]) > tol || Math.abs(ndc[1]) > tol) continue;
        const sx = (ndc[0] * 0.5 + 0.5) * viewportW;
        const sy = (-ndc[1] * 0.5 + 0.5) * viewportH;
        const w = measureLabelWidth(candidates[i].name) + LABEL_PAD_X;
        const h = 24; // GalaxyLabel pill height
        const left = sx - w / 2;
        const top = sy - h / 2;
        for (const r of rects) {
            if (left < r.x + r.w && left + w > r.x && top < r.y + r.h && top + h > r.y) {
                break; // overlaps a placed label
            }
        }
        if (out.length === rects.length) {
            // No overlap was found this iteration -> place it.
            rects.push({ x: left, y: top, w, h });
            out.push(i);
        }
    }
    return out;
}
