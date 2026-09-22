"use client";

// The per-frame loop, factored into its own module (same idiom + eslint carve-out
// as the vibe REBUILD renderer). It mutates ref-derived three.js state -- shader
// uniforms, the OrbitControls target, the camera -- from inside useFrame, which
// runs OUTSIDE React's render phase, so react-hooks/immutability does not apply
// (see eslint.config.mjs). Everything here is decorative motion + camera easing;
// nothing here is load-bearing data.
import { useRef, type RefObject, type Dispatch, type SetStateAction } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { QuadTree } from "./quadtree";

/** The subset of the OrbitControls instance the loop touches. */
export interface OrbitControlsLike {
    target: THREE.Vector3;
    autoRotate: boolean;
    enabled: boolean;
    update: () => void;
}

interface StarUniforms {
    uTime: { value: number };
    uFocal: { value: number };
    uDofRange: { value: number };
    uHiStrength: { value: number };
    uFocusIdx: { value: number };
    uYouIdx: { value: number };
    uFocusStrength: { value: number };
    // LIVE-STATE overlays: playing index (-1 = none, drives the enlarged white
    // star), and 1 when a search/blend has armed the per-star minidim. Directly
    // assignable here, exactly like the other uniforms below.
    uPlayingIdx: { value: number };
    uHighlightDim: { value: number };
}

export interface GalaxyFrameArgs {
    uniforms: StarUniforms;
    controls: RefObject<OrbitControlsLike | null>;
    coreRef: RefObject<THREE.Mesh | null>;
    flyGoal: RefObject<THREE.Vector3>;
    flyDist: RefObject<number | null>;
    /** Target for the explore-a-vibe sector glow (1 = a vibe is cast, 0 = none). */
    hiTarget: RefObject<number>;
    /** Target for the selection focus (1 = somebody is picked, 0 = nobody). */
    focusTarget: RefObject<number>;
    quad: QuadTree;
    xs: Float32Array;
    zs: Float32Array;
    reduced: boolean;
    near: boolean;
    setNear: Dispatch<SetStateAction<boolean>>;
    setClusterLabels: Dispatch<SetStateAction<number[]>>;
}

const CAMERA_KEY = "kima_vibemap_camera";

/** Restored camera state, or null when nothing was saved. */
export function restoreSavedCamera():
    | { position: [number, number, number]; target: [number, number, number] }
    | null {
    try {
        const raw = sessionStorage.getItem(CAMERA_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as {
            position: [number, number, number];
            target: [number, number, number];
        };
        if (!Array.isArray(v.position) || !Array.isArray(v.target)) return null;
        return v;
    } catch {
        return null;
    }
}

export function useGalaxyFrame(args: GalaxyFrameArgs) {
    const {
        uniforms, controls, coreRef, flyGoal, flyDist, hiTarget, focusTarget,
        quad, xs, zs, reduced, near, setNear, setClusterLabels,
    } = args;
    const frame = useRef(0);
    // Scratch vectors reused every frame -> no per-frame allocation in the fly-to.
    const dir = useRef(new THREE.Vector3());
    const desired = useRef(new THREE.Vector3());

    useFrame(({ clock, camera }) => {
        // Freeze the twinkle + accretion pulse under prefers-reduced-motion.
        if (!reduced) {
            uniforms.uTime.value = clock.elapsedTime;
            if (coreRef.current) {
                coreRef.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 0.6) * 0.035);
            }
        }

        // ease the explore-a-vibe sector glow toward its target (instant if reduced).
        uniforms.uHiStrength.value += (hiTarget.current - uniforms.uHiStrength.value) * (reduced ? 1 : 0.08);
        // ease the selection focus the same way -- picking somebody should feel like
        // the galaxy settling back, not a light switch. Instant under reduced-motion,
        // the same rule the sector glow follows.
        uniforms.uFocusStrength.value += (focusTarget.current - uniforms.uFocusStrength.value) * (reduced ? 1 : 0.1);

        const c = controls.current;
        // fly-to: glide the camera + target in. Under reduced-motion this is a JUMP
        // (lerp factor 1) instead of an eased glide.
        if (c && flyDist.current != null) {
            c.autoRotate = false;
            const k = reduced ? 1 : 0.09;
            c.target.lerp(flyGoal.current, k);
            dir.current.copy(camera.position).sub(c.target).normalize();
            desired.current.copy(c.target).addScaledVector(dir.current, flyDist.current);
            camera.position.lerp(desired.current, k);
            c.update();
            if (
                camera.position.distanceTo(desired.current) < 0.6 &&
                c.target.distanceTo(flyGoal.current) < 0.6
            ) {
                flyDist.current = null;
                if (!reduced) c.autoRotate = true; // reduced: autoRotate stays off
            }
        }

        const d = c ? camera.position.distanceTo(c.target) : camera.position.length();
        // tilt-shift: keep the focus on the field; the band tightens as you approach.
        uniforms.uFocal.value = d;
        uniforms.uDofRange.value = Math.max(38, d * 0.6);
        const z = d < 70;
        if (z !== near) setNear(z);

        // zone-reactive LOD: whoever sits near the current focus gets labelled.
        // Persist the camera so a revisit restores the last view instead of
        // replaying the intro fly-in. Throttled to every 90 frames — a session-
        // storage write is cheap but not free, and the view only changes when
        // the user drags.
        if (c && frame.current % 90 === 0) {
            try {
                sessionStorage.setItem(
                    CAMERA_KEY,
                    JSON.stringify({
                        position: camera.position.toArray(),
                        target: c.target.toArray(),
                    }),
                );
            } catch { /* private mode / quota — persistence is best-effort */ }
        }

        // Throttled; radius tightens as you approach.
        frame.current++;
        if (c && z && frame.current % 12 === 0) {
            const t = c.target;
            const r = Math.min(46, Math.max(7, d * 0.42));
            const inZone = quad.within(t.x, t.z, r, []);
            inZone.sort(
                (a, b) =>
                    (xs[a] - t.x) ** 2 + (zs[a] - t.z) ** 2 -
                    ((xs[b] - t.x) ** 2 + (zs[b] - t.z) ** 2),
            );
            const next = inZone.slice(0, 10);
            setClusterLabels((prev) =>
                prev.length === next.length && prev.every((v, k) => v === next[k]) ? prev : next,
            );
        }
    });
}
