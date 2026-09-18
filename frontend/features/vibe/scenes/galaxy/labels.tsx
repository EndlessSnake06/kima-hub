"use client";

// The presentational leaves of the scene: the drei <Html> name pill and the
// ground-plane reticle ring. Dark blurred pills with light text (+ an accent dot)
// so a name reads over the field at any angle. Lifted from the rig, unchanged in
// look; the pill font tracks the social display face where the app supplies it.
import type { CSSProperties } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { GALAXY_ZONES, zoneWorldPos } from "./zones";

const chipBase: CSSProperties = {
    fontFamily: "var(--font-montserrat, Montserrat), system-ui, sans-serif",
    fontSize: 9.5,
    letterSpacing: "0.02em",
    lineHeight: 1,
    whiteSpace: "nowrap",
    transform: "translate(-50%,-50%)",
    pointerEvents: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    borderRadius: 999,
    background: "rgba(8,5,14,0.72)",
    border: "1px solid rgba(255,240,214,0.14)", // warm --line-2
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    boxShadow: "0 2px 9px rgba(0,0,0,0.6)",
    color: "rgba(244,238,222,0.92)", // warm amber-white ink
};

export function GalaxyLabel({
    position,
    name,
    dot,
}: {
    position: [number, number, number];
    name: string;
    dot: string;
}) {
    return (
        <Html position={position} center distanceFactor={42} zIndexRange={[10, 0]}>
            <div style={chipBase}>
                <span
                    style={{
                        width: 4,
                        height: 4,
                        borderRadius: 999,
                        background: dot,
                        flex: "0 0 auto",
                    }}
                />
                {name}
            </div>
        </Html>
    );
}

export function Reticle({
    position,
    color,
    radius,
    renderOrder,
}: {
    position: [number, number, number];
    color: string;
    radius: number;
    renderOrder?: number;
}) {
    return (
        <mesh position={position} rotation-x={-Math.PI / 2} renderOrder={renderOrder}>
            <ringGeometry args={[radius - 0.1, radius, 72]} />
            <meshBasicMaterial
                color={color}
                transparent
                opacity={0.7}
                side={THREE.DoubleSide}
                depthWrite={false}
            />
        </mesh>
    );
}

// Decorative wayfinding region labels on the ambient terrain (the GALAXY_ZONES,
// like the rig's mood sectors). Purely aesthetic map regions -- NOT per-person data,
// not counted. Shown only at the overview so they don't clutter when zoomed in. The
// zone the baseline search flew you to reads brighter (focusedId).
export function RegionLabels({ show, radius, focusedId }: { show: boolean; radius?: number; focusedId?: string | null }) {
    if (!show) return null;
    return (
        <>
            {GALAXY_ZONES.map((rg) => {
                const focused = rg.id === focusedId;
                return (
                    <Html
                        key={rg.id}
                        position={zoneWorldPos(rg, radius)}
                        center
                        distanceFactor={110}
                        zIndexRange={[5, 0]}
                    >
                        <div
                            style={{
                                ...chipBase,
                                background: focused ? "rgba(8,5,14,0.66)" : "rgba(8,5,14,0.42)",
                                border: `1px solid ${focused ? "rgba(255,240,214,0.22)" : "rgba(255,240,214,0.07)"}`,
                                color: focused ? "rgba(244,238,222,0.9)" : "rgba(244,238,222,0.5)",
                                letterSpacing: "0.16em",
                            }}
                        >
                            {rg.name}
                        </div>
                    </Html>
                );
            })}
        </>
    );
}
