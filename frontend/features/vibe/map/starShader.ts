import * as THREE from "three";

/**
 * One point shader for every star on the vibe map: the library's tracks, the
 * dust around them and the backdrop sky. A star is a bright core inside a soft
 * halo, sized by distance, with a gentle per-star twinkle and a rare sparkle.
 * Every star stays pin-sharp; depth comes from perspective alone.
 *
 * Per-star attributes:
 *   aColor   linear RGB
 *   aSize    world-space size
 *   aPhase   twinkle phase (radians)
 *   aTwAmp   twinkle depth, 0 = steady
 *   aSpark   1 on the few stars that occasionally flare
 *   aEmph    emphasis (1 = normal, <1 recedes, >1 stands forward); eased on the CPU
 *   aMood    index of the track's dominant mood (-1 = none); tracks only
 *   aReveal  seconds into the load-in at which this star ignites
 *
 * Load-in: uReveal counts seconds since the map appeared. Each star fades in
 * from nothing at its own moment, arriving as a white flash that settles into
 * its own colour.
 *
 * Mood focus: while uFocusMix > 0, stars whose aMood equals uFocusMood take on
 * uFocusColor, so previewing a mood colours exactly its stars.
 */
const VERT = /* glsl */ `
uniform float uSizeScale;
uniform float uPixelRatio;
uniform float uTime;
uniform float uMinPx;
uniform float uReveal;
uniform float uRevealFade;
uniform float uFocusMood;
uniform float uFocusMix;
uniform vec3 uFocusColor;
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
attribute float aTwAmp;
attribute float aSpark;
attribute float aEmph;
attribute float aMood;
attribute float aReveal;
varying vec3 vColor;
varying float vTw;
varying float vEmph;
varying float vShow;
void main() {
  float focus = uFocusMix * step(abs(aMood - uFocusMood), 0.5) * step(-0.5, aMood);
  float lum = max(max(aColor.r, aColor.g), aColor.b);
  vec3 color = mix(aColor, uFocusColor * (0.55 + lum * 0.6), focus * 0.85);
  float settle = clamp((uReveal - aReveal) / (uRevealFade * 2.0), 0.0, 1.0);
  vColor = mix(vec3(1.0, 0.98, 0.94) * 1.4, color, settle);
  vShow = clamp((uReveal - aReveal) / uRevealFade, 0.0, 1.0);
  vEmph = aEmph;
  float sp = 0.35 + fract(aPhase * 0.1591) * 1.1;
  vTw = 1.0 - aTwAmp * (0.5 + 0.5 * sin(uTime * sp + aPhase));
  float spark = pow(max(0.0, sin(uTime * (0.25 + sp * 0.3) + aPhase * 4.0)), 60.0);
  vTw += spark * aSpark * 2.2;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.001);
  float ps = aSize * uSizeScale * uPixelRatio / depth;
  ps *= mix(0.8, 1.0, clamp(aEmph, 0.0, 1.0)) * max(1.0, aEmph) * (1.0 + focus * 0.25);
  gl_PointSize = clamp(ps, uMinPx * uPixelRatio, 48.0 * uPixelRatio);
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vTw;
varying float vEmph;
varying float vShow;
void main() {
  if (vShow <= 0.0) discard;
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.3, r);
  float halo = pow(max(0.0, 1.0 - r / 0.96), 2.0) * 0.6;
  float a = min(1.0, core * 0.92 + halo);
  gl_FragColor = vec4(vColor * max(1.0, vEmph), a * uOpacity * clamp(vTw, 0.0, 3.0) * min(1.0, vEmph) * vShow);
}`;

export interface StarUniforms {
    [key: string]: THREE.IUniform;
    uSizeScale: THREE.IUniform<number>;
    uPixelRatio: THREE.IUniform<number>;
    uOpacity: THREE.IUniform<number>;
    uTime: THREE.IUniform<number>;
    uMinPx: THREE.IUniform<number>;
    uReveal: THREE.IUniform<number>;
    uRevealFade: THREE.IUniform<number>;
    uFocusMood: THREE.IUniform<number>;
    uFocusMix: THREE.IUniform<number>;
    uFocusColor: THREE.IUniform<THREE.Color>;
}

export function createStarMaterial(opts: { sizeScale: number; opacity: number; minPx: number; revealFade?: number }) {
    const uniforms: StarUniforms = {
        uSizeScale: { value: opts.sizeScale },
        uPixelRatio: { value: typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio, 2) },
        uOpacity: { value: opts.opacity },
        uTime: { value: 0 },
        uMinPx: { value: opts.minPx },
        uReveal: { value: 0 },
        uRevealFade: { value: opts.revealFade ?? 0.3 },
        uFocusMood: { value: -1 },
        uFocusMix: { value: 0 },
        uFocusColor: { value: new THREE.Color(1, 1, 1) },
    };
    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
    });
    return { material, uniforms };
}

/** Per-frame update: twinkle clock, load-in clock, eased mood focus, and the canvas's live pixel ratio. */
export function tickStars(u: StarUniforms, time: number | null, reveal: number, focusMix: number, pixelRatio: number) {
    if (time !== null) u.uTime.value = time;
    u.uPixelRatio.value = pixelRatio;
    u.uReveal.value = reveal;
    u.uFocusMix.value = focusMix;
}

/** Which mood the legend is previewing, and its colour (0–255 RGB). */
export function setStarFocus(u: StarUniforms, moodIdx: number, rgb: [number, number, number]) {
    u.uFocusMood.value = moodIdx;
    u.uFocusColor.value.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

/** Soft radial falloff used for the nebula haze sprites. */
export function createGlowTexture() {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
}
