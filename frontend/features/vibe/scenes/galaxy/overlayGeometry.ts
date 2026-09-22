// Overlay geometry for the galaxy live-state overlays.
//
// Two overlays are polyLINES, so they are authored the same way: one 3+4
// (XYZ, RGBA) BufferGeometry each, rendered by a shared transparent line
// material. That lets the queue threads carry PER-VERTEX ALPHA (dim past /
// bright upcoming) while the song-path gradient carries PER-VERTEX COLOR
// (a 2-stop segment is simply two differently-colored endpoints). A plain
// LineBasicMaterial cannot express per-vertex alpha, hence the tiny custom
// ShaderMaterial built in buildLineMaterial().
//
// All builders are O(input) and pure — they read positions by index, never
// allocating a hot loop. Built in a useMemo keyed on their driving props,
// so a search/play gesture only rebuilds once, and disposed with the field.
import * as THREE from "three";
import type { PathResult } from "../../types";
import type { VibeOperation } from "@/lib/audio-state-context";

// Fixed world-unit radius for the operation source ring. The old deck.gl map
// scaled to pixels (getTrackRadius × 3); the scene has no zoom unit of its
// own, so a fixed world unit is the lowest-risk choice.
export const SOURCE_RING_RADIUS = 9;

// Queue-thread gold, replicated from the deck.gl queuePathLayer palette.
const QUEUE_RGB: [number, number, number] = [180, 160, 120];

// Resolve the operation source id + color the same way VibeMap's
// sourceRingLayer switched on activeOperation.type. Returns null when the
// operation isn't one with a drag source, or the source id isn't in the map.
export function sourceRingFromOp(
    op: VibeOperation | null,
    userIds: string[],
): { id: string; color: string; radius: number } | null {
    if (!op) return null;
    let id: string;
    let color: string;
    switch (op.type) {
        case "drift":
            id = op.startTrackId;
            color = "#ecb200";
            break;
        case "vibe":
            id = op.sourceTrackId;
            color = "#1db954";
            break;
        case "similar":
            id = op.sourceTrackId;
            color = "#5c8dd6";
            break;
        default:
            return null;
    }
    if (!userIds.includes(id)) return null;
    return { id, color, radius: SOURCE_RING_RADIUS };
}

/**
 * Queue threads: one 2-vertex segment per consecutive pair of queue ids.
 * Segments behind the playhead get alpha 25 (dim), the rest 50 (bright),
 * always gold [180,160,120]. O(queue). Null when there are <2 usable tracks.
 */
export function buildQueueSegments(
    userIds: string[],
    pos: Float32Array,
    queueIds: string[] | undefined,
    playingTrackId: string | null | undefined,
): THREE.BufferGeometry | null {
    if (!queueIds || queueIds.length < 2) return null;
    const playingQueueIdx =
        playingTrackId != null ? queueIds.indexOf(playingTrackId) : -1;
    const segs: Array<[number, number, number]> = [];
    for (let k = 0; k < queueIds.length - 1; k++) {
        const i = userIds.indexOf(queueIds[k]);
        const j = userIds.indexOf(queueIds[k + 1]);
        if (i < 0 || j < 0) continue;
        const isPast = playingQueueIdx >= 0 && k < playingQueueIdx;
        segs.push([i, j, isPast ? 25 : 50]);
    }
    if (segs.length === 0) return null;

    const n = segs.length * 2;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 4);
    for (let s = 0; s < segs.length; s++) {
        const i = segs[s][0];
        const j = segs[s][1];
        const alpha = segs[s][2];
        const vi = s * 2;
        const vj = s * 2 + 1;
        for (const [v, idx] of [
            [vi, i],
            [vj, j],
        ] as const) {
            positions[v * 3] = pos[idx * 3];
            positions[v * 3 + 1] = pos[idx * 3 + 1];
            positions[v * 3 + 2] = pos[idx * 3 + 2];
            colors[v * 4] = QUEUE_RGB[0] / 255;
            colors[v * 4 + 1] = QUEUE_RGB[1] / 255;
            colors[v * 4 + 2] = QUEUE_RGB[2] / 255;
            colors[v * 4 + 3] = alpha / 255;
        }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 4));
    return g;
}

/**
 * Song-path gradient polyline: one 2-vertex segment per consecutive pair of
 * path stops, colored start→end from the emitted 0..1 trackColors buffer,
 * full opacity (alpha 1.0). Stops outside the map are skipped, mirroring the
 * deck.gl pathLayer guard. O(path).
 */
export function buildPathSegments(
    userIds: string[],
    pos: Float32Array,
    result: PathResult | null,
    trackColors: Float32Array,
): THREE.BufferGeometry | null {
    if (!result) return null;
    const stops = [
        result.startTrack.id,
        ...result.path.map((p) => p.id),
        result.endTrack.id,
    ];
    const segs: Array<[number, number]> = [];
    for (let k = 0; k < stops.length - 1; k++) {
        const si = userIds.indexOf(stops[k]);
        const di = userIds.indexOf(stops[k + 1]);
        if (si < 0 || di < 0) continue;
        segs.push([si, di]);
    }
    if (segs.length === 0) return null;

    const n = segs.length * 2;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 4);
    for (let s = 0; s < segs.length; s++) {
        const si = segs[s][0];
        const di = segs[s][1];
        const vi = s * 2;
        const vj = s * 2 + 1;
        for (const [v, idx] of [
            [vi, si],
            [vj, di],
        ] as const) {
            positions[v * 3] = pos[idx * 3];
            positions[v * 3 + 1] = pos[idx * 3 + 1];
            positions[v * 3 + 2] = pos[idx * 3 + 2];
            colors[v * 4] = trackColors[idx * 3];
            colors[v * 4 + 1] = trackColors[idx * 3 + 1];
            colors[v * 4 + 2] = trackColors[idx * 3 + 2];
            colors[v * 4 + 3] = 1.0;
        }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 4));
    return g;
}

/**
 * The one shared transparent line material. Geometry supplies its own RGBA
 * (attribute `aColor`), so this doesn't set vertexColors. Alpha blends over
 * the black field; depth-write disabled so the translucent queue lines sort
 * by renderOrder rather than depth.
 */
export function buildLineMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        vertexShader: `
            attribute vec4 aColor;
            varying vec4 vColor;
            void main() {
                vColor = aColor;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec4 vColor;
            void main() {
                gl_FragColor = vColor;
            }
        `,
        transparent: true,
        depthWrite: false,
    });
}
