// Layer 1 — the ambient galaxy baseline geometry. Shape + identity colour come from
// the ported rig layout (vibeGalaxyLayout: synth manifold → PCA → the "guitar-pick"
// disc, coloured by OKLab identity). Here we add the rig's fine-star LOOK: a bright
// few over a faint many, small point sizes (fine grain), and a gentle per-star
// twinkle. Purely DECORATIVE terrain -- never labelled, hovered, selected, counted,
// or indexed for picking. Matches approved-galaxy3d.png; the real people are a
// separate bright overlay sampled FROM this field (useGalaxyField / peopleField, Layer 2).
import * as THREE from "three";
import type { VibeGalaxy } from "./vibeGalaxyLayout";
import { zoneIndexForAngle } from "./zones";

function makeRng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Build the decorative baseline geometry from a pre-built galaxy (pos + identity
 *  colour). The same galaxy's positions are shared with peopleField so real people
 *  sample from exactly this distribution. */
export function buildBaselineGeometry(galaxy: VibeGalaxy): THREE.BufferGeometry {
    const count = galaxy.count;
    const rnd = makeRng(0xa17e);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phase = new Float32Array(count);
    const twAmp = new Float32Array(count);
    const spark = new Float32Array(count);
    // Each field star's wayfinding sector (0-3), by its angle on the disc -> drives the
    // explore-a-vibe glow. Purely decorative partition of the deterministic field.
    const sector = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        sector[i] = zoneIndexForAngle(Math.atan2(galaxy.pos[i * 3 + 2], galaxy.pos[i * 3]));
        // dynamic range (rig): a bright few over a faint many -> a real field, not
        // uniform dots. Keeps the identity hue from vibeColor, scaled by brightness.
        const notable = rnd() < 0.11;
        const b = notable ? 0.7 + rnd() * 0.3 : 0.16 + rnd() * 0.24;
        colors[i * 3] = galaxy.color[i * 3] * b;
        colors[i * 3 + 1] = galaxy.color[i * 3 + 1] * b;
        colors[i * 3 + 2] = galaxy.color[i * 3 + 2] * b;
        sizes[i] = notable ? 1.5 + rnd() * 0.8 : 0.7 + rnd() * 0.4; // fine grain
        phase[i] = rnd() * 6.283;
        twAmp[i] = 0.14 + rnd() * 0.2;
        spark[i] = rnd() < 0.02 ? 1 : 0;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(galaxy.pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTwAmp", new THREE.BufferAttribute(twAmp, 1));
    g.setAttribute("aSpark", new THREE.BufferAttribute(spark, 1));
    g.setAttribute("aSector", new THREE.BufferAttribute(sector, 1));
    // -1 everywhere: an ambient star is nobody, so it can never be one of the two
    // ends of a selection thread and always recedes when somebody is picked. The
    // attribute has to be PRESENT rather than merely absent -- a missing attribute
    // reads as 0 in the shader, and 0 is a real person's index.
    g.setAttribute("aIndex", new THREE.BufferAttribute(new Float32Array(count).fill(-1), 1));
    return g;
}
