import * as THREE from "three";

/**
 * The sky behind the library: stars scattered through a deep shell around the
 * map, at every distance from just past the field's edge to far away, so they
 * shift against each other as the camera moves. They twinkle on their own slow
 * clocks and a few flare now and then. None of this is data; it is depth.
 */
const SKY_STARS = 7000;
const INNER = 150;
const OUTER = 440;

// Mostly warm white, some cool steel, a little gold and rose, one faint violet.
const PALETTE = ["#f3ecdd", "#f3ecdd", "#efe6d2", "#dfe6f3", "#f0c07a", "#e79db0", "#b58fd6"];

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function buildSkyField(): THREE.BufferGeometry {
    const rand = rng(0x9e3d);
    const pos = new Float32Array(SKY_STARS * 3);
    const col = new Float32Array(SKY_STARS * 3);
    const size = new Float32Array(SKY_STARS);
    const phase = new Float32Array(SKY_STARS);
    const amp = new Float32Array(SKY_STARS);
    const spark = new Float32Array(SKY_STARS);
    const palette = PALETTE.map((hex) => new THREE.Color(hex));

    for (let i = 0; i < SKY_STARS; i++) {
        // Uniform direction, radius biased outward so the far sky is densest.
        const u = rand() * 2 - 1;
        const theta = rand() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const r = INNER + Math.pow(rand(), 0.7) * (OUTER - INNER);
        pos[i * 3] = Math.cos(theta) * s * r;
        pos[i * 3 + 1] = u * r * 0.75;
        pos[i * 3 + 2] = Math.sin(theta) * s * r;

        const c = palette[Math.floor(rand() * palette.length)];
        // A bright few over a faint many, dimmer with distance.
        const bright = rand() < 0.05;
        const fade = 1 - ((r - INNER) / (OUTER - INNER)) * 0.45;
        const b = (bright ? 0.8 + rand() * 0.45 : 0.1 + Math.pow(rand(), 2.4) * 0.4) * fade;
        col[i * 3] = c.r * b;
        col[i * 3 + 1] = c.g * b;
        col[i * 3 + 2] = c.b * b;

        size[i] = bright ? 1.5 + rand() * 1.1 : 0.7 + rand() * 0.7;
        phase[i] = rand() * Math.PI * 2;
        amp[i] = 0.3 + rand() * 0.55;
        spark[i] = rand() < 0.04 ? 1 : 0;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTwAmp", new THREE.BufferAttribute(amp, 1));
    g.setAttribute("aSpark", new THREE.BufferAttribute(spark, 1));
    g.setAttribute("aEmph", new THREE.BufferAttribute(new Float32Array(SKY_STARS).fill(1), 1));
    g.setAttribute("aMood", new THREE.BufferAttribute(new Float32Array(SKY_STARS).fill(-1), 1));
    g.setAttribute("aReveal", new THREE.BufferAttribute(new Float32Array(SKY_STARS), 1));
    return g;
}
