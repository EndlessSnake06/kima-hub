import * as THREE from "three";
import { blendMoodColor } from "../mapUtils";
import type { MapTrack } from "../types";
import { FIELD_RADIUS, hash01, type TrackField } from "./trackField";

/**
 * The nebula is drawn from the library itself, never painted on:
 *
 *  - Haze: faint glows sitting on the densest pockets of the cloud, tinted by
 *    the moods that live there and strongest where the most tracks crowd
 *    together. A sparse region stays clear sky.
 *  - Dust: a few dim motes scattered close around each star, so clusters read
 *    as luminous gas rather than a handful of points.
 */

export interface HazePuff {
    position: [number, number, number];
    scale: number;
    color: THREE.Color;
    opacity: number;
}

const HAZE_GRID = 8;
const HAZE_MAX = 18;
const DEEP = new THREE.Color("#221d3a");

export function buildHaze(tracks: MapTrack[], field: TrackField): HazePuff[] {
    const n = tracks.length;
    if (n < 12) return [];
    const cellSize = (FIELD_RADIUS * 2) / HAZE_GRID;
    const cells = new Map<number, { n: number; x: number; y: number; z: number; r: number; g: number; b: number }>();
    const p = field.positions;
    for (let i = 0; i < n; i++) {
        const cx = Math.min(HAZE_GRID - 1, Math.max(0, Math.floor((p[i * 3] + FIELD_RADIUS) / cellSize)));
        const cy = Math.min(HAZE_GRID - 1, Math.max(0, Math.floor((p[i * 3 + 1] + FIELD_RADIUS) / cellSize)));
        const cz = Math.min(HAZE_GRID - 1, Math.max(0, Math.floor((p[i * 3 + 2] + FIELD_RADIUS) / cellSize)));
        const key = (cz * HAZE_GRID + cy) * HAZE_GRID + cx;
        const cell = cells.get(key) ?? { n: 0, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 };
        const [r, g, b] = blendMoodColor(tracks[i], 1.4);
        cell.n++;
        cell.x += p[i * 3]; cell.y += p[i * 3 + 1]; cell.z += p[i * 3 + 2];
        cell.r += r; cell.g += g; cell.b += b;
        cells.set(key, cell);
    }
    const minCount = Math.max(4, Math.round(n * 0.006));
    const dense = [...cells.values()].filter((c) => c.n >= minCount).sort((a, b) => b.n - a.n).slice(0, HAZE_MAX);
    if (dense.length === 0) return [];
    const top = dense[0].n;
    return dense.map((c) => {
        const density = c.n / top;
        const tint = new THREE.Color().setRGB(c.r / c.n / 255, c.g / c.n / 255, c.b / c.n / 255, THREE.SRGBColorSpace);
        return {
            position: [c.x / c.n, c.y / c.n, c.z / c.n] as [number, number, number],
            scale: cellSize * (1.6 + 1.2 * density),
            color: DEEP.clone().lerp(tint, 0.2),
            opacity: 0.012 + 0.03 * density,
        };
    });
}

const DUST_BUDGET = 40000;

export function buildDust(tracks: MapTrack[], field: TrackField): THREE.BufferGeometry {
    const n = tracks.length;
    const perStar = n === 0 ? 0 : Math.max(1, Math.min(4, Math.floor(DUST_BUDGET / n)));
    const count = Math.min(DUST_BUDGET, n * perStar);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const reveal = new Float32Array(count);
    const trackReveal = field.geometry.getAttribute("aReveal") as THREE.BufferAttribute;
    const spread = field.baseSize * 3.2;
    const warm = new THREE.Color("#d9cfc0");
    for (let k = 0; k < count; k++) {
        // Spread evenly over the whole library, whatever its size.
        const i = Math.min(n - 1, Math.floor((k * n) / count));
        // A point inside a small ball around the star, denser toward it.
        const u = hash01(k, 11) * 2 - 1;
        const th = hash01(k, 12) * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const r = spread * Math.pow(hash01(k, 13), 0.6);
        pos[k * 3] = field.positions[i * 3] + Math.cos(th) * s * r;
        pos[k * 3 + 1] = field.positions[i * 3 + 1] + u * r;
        pos[k * 3 + 2] = field.positions[i * 3 + 2] + Math.sin(th) * s * r;
        const b = 0.07 + hash01(k, 14) * 0.1;
        col[k * 3] = warm.r * b; col[k * 3 + 1] = warm.g * b; col[k * 3 + 2] = warm.b * b;
        size[k] = 0.3 + hash01(k, 15) * 0.35;
        phase[k] = hash01(k, 16) * Math.PI * 2;
        reveal[k] = trackReveal ? trackReveal.getX(i) + 0.1 : 0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTwAmp", new THREE.BufferAttribute(new Float32Array(count).fill(0.15), 1));
    g.setAttribute("aSpark", new THREE.BufferAttribute(new Float32Array(count), 1));
    g.setAttribute("aEmph", new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    g.setAttribute("aMood", new THREE.BufferAttribute(new Float32Array(count).fill(-1), 1));
    g.setAttribute("aReveal", new THREE.BufferAttribute(reveal, 1));
    return g;
}
