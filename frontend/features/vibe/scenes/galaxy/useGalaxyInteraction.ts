"use client";

// Pointer picking against the people quadtree, factored out for the same eslint
// carve-out reason as useGalaxyFrame: the down-gesture ref is mutated from DOM
// pointer callbacks (outside React's render phase). Hover previews a node; a
// click (a press that didn't drag) SELECTS a real person -> the page opens the
// real ProfileDrawer with that userId. Clicking empty space does nothing.
import { useCallback, useRef, useState, type RefObject } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import type { QuadTree } from "./quadtree";
import type { OrbitControlsLike } from "./useGalaxyFrame";

export interface GalaxyInteraction {
    hover: number | null;
    setHover: (i: number | null) => void;
    onMove: (e: ThreeEvent<PointerEvent>) => void;
    onOut: () => void;
    onDown: (e: ThreeEvent<PointerEvent>) => void;
    onUp: (e: ThreeEvent<PointerEvent>) => void;
}

export function useGalaxyInteraction(
    quad: QuadTree,
    controls: RefObject<OrbitControlsLike | null>,
    onPick: (nodeIndex: number) => void,
): GalaxyInteraction {
    const [hover, setHover] = useState<number | null>(null);
    const down = useRef<{ x: number; y: number } | null>(null);

    const onMove = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            const c = controls.current;
            const dist = c ? e.camera.position.distanceTo(c.target) : e.camera.position.length();
            const rad = Math.max(1.0, dist * 0.02);
            const hit = quad.nearest(e.point.x, e.point.z, rad);
            setHover(hit ? hit.i : null);
        },
        [quad, controls],
    );

    const onOut = useCallback(() => setHover(null), []);

    const onDown = useCallback((e: ThreeEvent<PointerEvent>) => {
        down.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
    }, []);

    const onUp = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            const d0 = down.current;
            down.current = null;
            const c = controls.current;
            if (!d0 || !c) return;
            // a drag (orbit), not a click -> ignore
            if (Math.hypot(e.nativeEvent.clientX - d0.x, e.nativeEvent.clientY - d0.y) > 6) return;
            const cur = e.camera.position.distanceTo(c.target);
            const hit = quad.nearest(e.point.x, e.point.z, Math.max(1.5, cur * 0.03));
            if (hit) {
                setHover(hit.i);
                onPick(hit.i);
            }
        },
        [quad, controls, onPick],
    );

    return { hover, setHover, onMove, onOut, onDown, onUp };
}
