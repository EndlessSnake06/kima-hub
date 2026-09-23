// The point-cloud shader + the two canvas textures, lifted from the people-preview
// rig (features/people/GalaxyScene.tsx) and pared to what the real-people galaxy
// needs. Dropped from the rig: the "online" pulse (aPulse), which drove synthetic
// presence data this scene doesn't feed real values into -- `GET /discover/people`
// still carries no per-node presence at all, so a pulse here would be decoration
// pretending to be a fact. Per-person moods HAVE been on the discover payload
// since N26 landed, but aren't wired into this shader either.
//
// What stays is decorative + honest: per-vertex LOD point-size, sine twinkle,
// rare sparkle, the tilt-shift depth-of-field grade, the explore-a-vibe sector
// glow, and the selection focus -- the last two are both "everything else
// recedes" effects driven entirely by what the viewer just did, never by a claim
// about anybody.
import * as THREE from "three";

export const STAR_VERT = /* glsl */ `
uniform float uSizeScale;
uniform float uPixelRatio;
uniform float uTime;
uniform float uFocal;     // camera->focus distance (the crisp band)
uniform float uDofRange;  // half-width of the in-focus band
uniform float uHiSector;  // highlighted sector index (-1 = none) -- explore-a-vibe glow
uniform float uHiStrength;// 0..1 ramp of the sector glow
uniform float uFocusIdx;  // selected person's index in the people cloud (-1 = none)
uniform float uYouIdx;    // your own index -- the other end of the thread, never recedes
uniform float uFocusStrength; // 0..1 ramp of the selection focus
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
attribute float aTwAmp;
attribute float aSpark;   // 0 mostly; 1 on the rare sparkle stars
attribute float aSector;  // field star's sector (0-3); <0 = a real person (never glows)
attribute float aIndex;   // person's index in the people cloud; -1 on every ambient star
varying vec3 vColor;
varying float vTw;
varying float vBlur;
varying float vGlow;
void main() {
  vColor = aColor;
  // explore-a-vibe SECTOR GLOW: when a vibe is cast (uHiStrength -> 1) the field stars
  // in that sector brighten (x1.4) and the rest recede (x0.28), a smooth ramp so the
  // galaxy stays visible. aSector < 0 (real people) are exempt -> glow term = 1.
  float affected = step(0.0, aSector);
  float member = affected * step(abs(aSector - uHiSector), 0.5);
  float glowTarget = member > 0.5 ? 1.4 : 0.28;
  vGlow = mix(1.0, glowTarget, uHiStrength * affected);
  // SELECTION FOCUS: picking somebody recedes the whole galaxy so the thread
  // between you and them is the only thing left reading. Exactly two points stay
  // lit -- them, and you at the other end of the line -- and everybody else
  // recedes as far as the decorative stars do, because "everyone except these
  // two" is the entire point of the gesture. Ambient stars carry aIndex = -1 and
  // so can never be mistaken for either end.
  // 0.5, not the 0.28 the sector glow recedes to: the profile drawer that opens
  // on the same click already darkens the whole page behind it, and the two
  // multiply. At 0.18 the galaxy vanished outright when rendered -- and a thread
  // with nothing behind it is not a connection, it is a line on black. The rig's
  // rule holds either way: the galaxy stays VISIBLE, it just stops competing.
  float picked = clamp(step(abs(aIndex - uFocusIdx), 0.5) + step(abs(aIndex - uYouIdx), 0.5), 0.0, 1.0);
  vGlow *= mix(1.0, mix(0.5, 1.0, picked), uFocusStrength);
  // smooth per-star sine twinkle: time-driven, per-point speed + phase from aPhase
  // -> natural shimmer, independent of camera (never a strobe). uTime is frozen
  // under prefers-reduced-motion (the frame loop stops advancing it), so this
  // whole term goes still -- decorative only, never load-bearing.
  float sp = 0.5 + fract(aPhase * 0.1591) * 1.3;
  vTw = 1.0 - aTwAmp * (0.5 + 0.5 * sin(uTime * sp + aPhase));
  // random SPARKLE: rare, sharp bright pops -> life in the field.
  float spark = pow(max(0.0, sin(uTime * (0.6 + sp * 0.5) + aPhase * 4.0)), 42.0);
  vTw += spark * aSpark * 2.4;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.001);
  // TILT-SHIFT depth-of-field: crisp at the focal band, blooming to soft bokeh
  // fore & aft -> the miniature/toy look.
  float blur = clamp(abs(depth - uFocal) / uDofRange, 0.0, 1.0);
  vBlur = blur;
  float ps = aSize * uSizeScale * uPixelRatio / depth;
  ps *= (1.0 + blur * 1.0);   // out-of-focus points swell into bokeh
  ps *= mix(1.0, vGlow, 0.6);  // glowing sector's stars grow, receding ones shrink
  gl_PointSize = clamp(ps, 2.2, 40.0);
}`;

export const STAR_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vTw;
varying float vBlur;
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  // premium star: a bright saturated CORE + a soft colored HALO, never a flat white
  // disc. Core tightens in focus, blooms out of focus (tilt-shift).
  float dd = r * 2.0; // 0 centre .. 1 edge
  float core = 1.0 - smoothstep(0.0, mix(0.30, 0.62, vBlur), dd);
  float halo = pow(max(0.0, 1.0 - dd / 0.96), 2.0) * 0.6;
  float a = min(1.0, core * 0.92 + halo);
  a *= (1.0 - vBlur * 0.35); // out-of-focus dims a touch -> depth
  gl_FragColor = vec4(vColor, a * uOpacity * clamp(vTw, 0.0, 3.0) * vGlow);
}`;

/** Soft radial glow sprite — the faint nebula wisps. Client-only (uses <canvas>). */
export function glowTexture(): THREE.CanvasTexture {
    const size = 128;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(cv);
}

/**
 * The event horizon: a near-opaque black core that fades to transparent at the rim.
 * Drawn over the field so it OCCLUDES the backdrop behind it -> a real dark void the
 * arms wind into (the accretion arc curves under it), not a gap in the stars. This is
 * the approved galaxy's centerpiece. Purely decorative.
 */
export function holeTexture(): THREE.CanvasTexture {
    const size = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, "rgba(1,1,3,1)");
    g.addColorStop(0.52, "rgba(1,1,3,0.99)");
    g.addColorStop(0.78, "rgba(1,1,3,0.6)");
    g.addColorStop(1.0, "rgba(1,1,3,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(cv);
}
