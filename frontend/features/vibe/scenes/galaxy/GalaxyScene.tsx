/**
 * GalaxyScene — the vibe "galaxy" view, built from the unified repo's
 * proven galaxy rig (kima-hub-unified frontend/features/social/galaxy/),
 * with our REAL data source swapped in (/api/vibe/map tracks).
 *
 * TWO independent layers, same rig structure:
 *   Layer 1 (ambient) — the "guitar-pick" terrain built from real UMAP +
 *     mood PCA positions, coloured by OKLab mood anchors. Purely decorative;
 *     never labelled or picked.
 *   Layer 2 (real) — every track as a star at its real UMAP x,y (picking
 *     stays truthful: neighbours ARE similar songs). Selected, labelled,
 *     clickable -> opens the TrackDrawer (double-click -> play).
 *
 * Colour = vibeColor() OKLab mood-anchor blend fed by each track's REAL
 * moods record, chroma capped at 0.17 (matter-not-neon).
 * Z axis = third PCA component of the 7-d mood covariance, scaled to
 * ±(discRadius * 0.06).
 *
 * Post-processing: Bloom + Noise + Vignette (EffectComposer), tilt-shift
 * DOF (uFocal/uDofRange), per-star twinkle (aPhase/aTwAmp).
 * Selection focus: everything except selected recedes (uFocusIdx), 0.5
 * recede floor.
 */
"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentRef,
    type RefObject,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import { STAR_VERT, STAR_FRAG, glowTexture, holeTexture } from "./shaders";
import { buildTrackGalaxy } from "./trackGalaxyLayout";
import { buildBackgroundStars } from "./backgroundStars";
import { QuadTree } from "./quadtree";
import { useGalaxyFrame, type OrbitControlsLike } from "./useGalaxyFrame";
import { useGalaxyInteraction } from "./useGalaxyInteraction";
import { GalaxyLabel, Reticle, RegionLabels } from "./labels";
import { resolveLabels, MAX_LABELS } from "./labelPlacement";
import { buildBaselineGeometry } from "./ambientBaseline";
import { GALAXY_ZONES, zoneWorldPos } from "./zones";
import type { MapTrack } from "../../types";

// Disc radius in world units (matches the rig).
const DISC_RADIUS = 60;
// Render order for the real-star layer (over the event-horizon hole).
const PEOPLE_ORDER = 5;
// Amber accent for the "you" marker — reused from the rig.
const AMBER = "#c98f3f";
/** Default camera position: a gentle tilt looking at the disc. */
const CAM_POSITION = [0, 96, 62] as const;
const CAM_FOV = 40;

// ── per-track star attributes ────────────────────────────────────────────────
// Deterministic per-index twinkle phase (same as the rig's pattern).
// Kept as a pure helper so the layout module stays the single source of
// truth for star attributes — referenced via the rig's attribute set.
function _twinklePhase(i: number): number {
    return ((i * 2654435761) % 6283) / 1000;
}

export interface GalaxySceneProps {
    tracks: MapTrack[];
    highlightedIds: Set<string>;
    playingTrackId?: string | null;
    selectedTrackId: string | null;
    queueTrackIds?: string[];
    activeOperation?: { type: string } | null;
    showLabels?: boolean;
    onTrackClick: (trackId: string) => void;
    onTrackDoubleClick?: (trackId: string) => void;
    onTrackContextMenu?: (trackId: string, op: "vibe" | "similar" | "drift") => void;
    onBackgroundClick: () => void;
}

function pos3(pos: Float32Array, i: number): [number, number, number] {
    return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
}

// ── Layer 1: the ambient "guitar-pick" terrain (decorative) ──────────────────
function Cosmos({
    baselineGeo,
    mat,
    bgGeo,
    bgMat,
    glow,
    hole,
    coreRef,
}: {
    baselineGeo: THREE.BufferGeometry;
    mat: THREE.ShaderMaterial;
    bgGeo: THREE.BufferGeometry;
    bgMat: THREE.ShaderMaterial;
    glow: THREE.Texture;
    hole: THREE.Texture;
    coreRef: RefObject<THREE.Mesh | null>;
}) {
    return (
        <>
            {/* Layer 0 — deep background starfield behind the disc (depth cue) */}
            <points geometry={bgGeo} material={bgMat} />
            <points geometry={baselineGeo} material={mat} />
            {/* Two faint far nebula wisps — a whisper of violet depth at the edges. */}
            {[
                { p: [-165, 26, -150] as const, s: 150, c: "#5f2f8e" },
                { p: [160, -44, 120] as const, s: 150, c: "#7d2f66" },
            ].map((n, i) => (
                <sprite key={i} position={n.p} scale={n.s}>
                    <spriteMaterial
                        map={glow}
                        color={n.c}
                        transparent
                        opacity={0.04}
                        blending={THREE.AdditiveBlending}
                        depthWrite={false}
                    />
                </sprite>
            ))}
            {/* Event horizon: a dark void the arms wind into, drawn over the field
                (renderOrder 4). coreRef gets the gentle accretion pulse. */}
            <group rotation-x={-Math.PI / 2}>
                <mesh ref={coreRef} renderOrder={4}>
                    <planeGeometry args={[15, 15]} />
                    <meshBasicMaterial
                        map={hole}
                        transparent
                        opacity={1}
                        depthWrite={false}
                    />
                </mesh>
            </group>
        </>
    );
}

// ── the main scene (all logic, ported from rig's Scene) ───────────────────────
function Scene(props: GalaxySceneProps) {
    const {
        tracks,
        playingTrackId,
        selectedTrackId,
        showLabels,
        onTrackClick,
        onTrackDoubleClick,
        onTrackContextMenu,
        onBackgroundClick,
    } = props;

    const { field, starGeo, quad, baselineGeo } = useTrackGalaxyField(
        tracks,
        DISC_RADIUS,
    );

    // Layer 0 geometry — screen-sampled deep starfield (see backgroundStars.ts;
    // generator was verified in Node: every star on-screen, behind the disc,
    // inside the crisp DOF band).
    const bgGeo = useMemo(() => buildBackgroundStars(), []);

    // Layer 0 material — its own uniforms: the deep stars sit at depth 117-165
    // (vs the disc's ~60-120), so uFocal 180 / uDofRange 140 keeps the whole
    // placement band inside the crisp DOF V, and uSizeScale 230 was measured
    // to render the 0.5-1.65 world-unit stars as ~2-5px pinpoints. The previous
    // pass's 310/260 turned every far star into a bokeh blob —
    // rejected that; do not "improve" these numbers back without re-measuring.
    const bgMat = useMemo(
        () =>
            new THREE.ShaderMaterial({
                uniforms: {
                    uSizeScale: { value: 230 },
                    uPixelRatio: {
                        value:
                            typeof window !== "undefined"
                                ? Math.min(window.devicePixelRatio, 1.5)
                                : 1,
                    },
                    uOpacity: { value: 0.9 },
                    uTime: { value: 0 },
                    uFocal: { value: 180 },
                    uDofRange: { value: 140 },
                    uHiSector: { value: -1 },
                    uHiStrength: { value: 0 },
                    uFocusIdx: { value: -1 },
                    uYouIdx: { value: -1 },
                    uFocusStrength: { value: 0 },
                },
                vertexShader: STAR_VERT,
                fragmentShader: STAR_FRAG,
                transparent: true,
                depthWrite: false,
            }),
        [],
    );
    useFrame(({ clock }) => {
        bgMat.uniforms.uTime.value = clock.elapsedTime;
    });
    useEffect(
        () => () => {
            bgGeo.dispose();
            bgMat.dispose();
        },
        [bgGeo, bgMat],
    );

    useThree();
    const { camera, gl } = useThree();

    const [near, setNear] = useState(false);
    const [clusterLabels, setClusterLabels] = useState<number[]>([]);
    const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
    const coreRef = useRef<THREE.Mesh>(null);
    const controls = useRef<OrbitControlsLike | null>(null);
    const flyGoal = useRef(new THREE.Vector3());
    const flyDist = useRef<number | null>(null);
    const hiTarget = useRef(0); // explore-a-vibe glow target
    const focusTarget = useRef(0); // selection focus target

    const glow = useMemo(() => glowTexture(), []);
    const hole = useMemo(() => holeTexture(), []);

    const uniforms = useMemo(
        () => ({
            uSizeScale: { value: 118 },
            uPixelRatio: {
                value:
                    Math.min(
                        typeof window !== "undefined"
                            ? window.devicePixelRatio
                            : 1,
                        1.5,
                    ) ?? 1,
            },
            uOpacity: { value: 0.9 },
            uTime: { value: 0 },
            uFocal: { value: 98 },
            uDofRange: { value: 70 },
            uHiSector: { value: -1 },
            uHiStrength: { value: 0 },
            uFocusIdx: { value: -1 },
            uYouIdx: { value: -1 },
            uFocusStrength: { value: 0 },
        }),
        [],
    );
    const mat = useMemo(
        () =>
            new THREE.ShaderMaterial({
                uniforms,
                vertexShader: STAR_VERT,
                fragmentShader: STAR_FRAG,
                transparent: true,
                depthWrite: false,
            }),
        [uniforms],
    );

    // Free imperatively-created GPU resources on unmount.
    useEffect(() => () => {
        glow.dispose();
        hole.dispose();
    }, [glow, hole]);
    useEffect(() => () => {
        mat.dispose();
    }, [mat]);

    // Real-star layer geometry is built in useTrackGalaxyField; it already
    // carries every attribute the shader needs.

    // ── interaction ──────────────────────────────────────────────────────────
    const selectedIndex =
        selectedTrackId !== null ? field.userIds.indexOf(selectedTrackId) : -1;
    const onPick = useCallback(
        (nodeIndex: number) => {
            const id = field.userIds[nodeIndex];
            if (id === undefined) return;
            onTrackClick(id);
        },
        [onTrackClick, field],
    );
    const { hover, onMove, onOut, onDown, onUp } = useGalaxyInteraction(
        quad,
        controls,
        onPick,
    );

    // Double-click via the same pointer-up path: the rig's interaction hook
    // does single-pick; we layer double-click detection on the star index.
    const lastClickRef = useRef<{ index: number; time: number } | null>(null);
    const onUpWithDbl = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            onUp(e);
            if (!onTrackDoubleClick) return;
            // r3f pointer events carry `index` from the raycast intersection.
            const idx = e.index ?? hover;
            if (idx === null || idx === undefined) return;
            const now = Date.now();
            const last = lastClickRef.current;
            if (last && last.index === idx && now - last.time < 400) {
                lastClickRef.current = null;
                const id = field.userIds[idx];
                if (id !== undefined) onTrackDoubleClick(id);
            } else {
                lastClickRef.current = { index: idx, time: now };
            }
        },
        [onUp, onTrackDoubleClick, hover, field],
    );

    // Right-click context menu (vibe/similar/drift) — same handlers the old
    // 2D grid view used on page.tsx.
    const onContextMenu = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            const idx = e.index;
            if (idx === undefined || idx < 0 || idx >= field.userIds.length) return;
            const id = field.userIds[idx];
            if (!id) return;
            e.nativeEvent.preventDefault();
            onTrackContextMenu?.(id, "vibe");
        },
        [onTrackContextMenu, field],
    );

    useGalaxyFrame({
        uniforms,
        controls,
        coreRef,
        flyGoal,
        flyDist,
        hiTarget,
        focusTarget,
        quad,
        xs: field.xs,
        zs: field.zs,
        reduced: false, // TODO: gate on prefers-reduced-motion via a prop
        near,
        setNear,
        setClusterLabels,
    });

    // ── SELECTION FOCUS (adapted from the rig): picking somebody recedes the
    // rest of the galaxy so that track is the only one left reading. In the
    // social rig a second lit point marked "you" at the other end of the
    // thread; this is a *tracks* map with no self, so `uYouIdx` is pinned to
    // -1 (unlit) and only the picked track stays bright. Keeping the attribute
    // set (not dropping it) matters: ambient stars carry aIndex=-1, so without
    // the uniform a "you" star could masquerade as the selection. ────────
    useEffect(() => {
        uniforms.uFocusIdx.value = selectedIndex;
        uniforms.uYouIdx.value = -1; // no "you" in a tracks galaxy
        focusTarget.current = selectedIndex >= 0 ? 1 : 0;
    }, [selectedIndex, uniforms]);

    // ── fly to a track picked from toolbar search results (rig's focus fly) ──
    // `selectedTrackId` changing = a toolbar pick -> fly camera to that star.
    useEffect(() => {
        if (!selectedTrackId || !controls.current) return;
        const i = field.userIds.indexOf(selectedTrackId);
        if (i < 0) return;
        flyGoal.current.set(field.xs[i], 0, field.zs[i]);
        flyDist.current = 32;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTrackId]);

    // ── back to the whole-galaxy overview ────────────────────────────────────
    useEffect(() => {
        if (!selectedTrackId) {
            // When selection clears, return to overview (only if not mid-fly).
            if (!controls.current) return;
            flyGoal.current.set(0, 0, 0);
            flyDist.current = 113;
            setActiveZoneId(null);
            hiTarget.current = 0;
        }
    }, [selectedTrackId]);

    // ── labels: ordered by presentation priority. Selection > hover >
    // playing > nearest-to-focus; resolved against the view frustum + collides
    // in screen space by resolveLabels, so the pile can
    // never exceed MAX_LABELS. Priority index doubles as the candidate order.
    const labelCandidates = useMemo(() => {
        const out: {
            world: [number, number, number];
            name: string;
            priority: number;
            id: string;
        }[] = [];
        let priority = 0;
        const add = (i: number | null) => {
            if (i === null || i < 0 || i >= field.userIds.length) return;
            const p = pos3(field.pos, i);
            out.push({
                world: [p[0], p[1] + 2.4, p[2]],
                name: field.titles[i],
                priority: priority++,
                id: field.userIds[i],
            });
        };
        // Highest priority first: the picked track, the hovered one, the playing
        // one, then the camera-target neighbourhood (already nearest-first).
        add(selectedIndex);
        add(hover);
        const playingIndex = playingTrackId != null ? field.userIds.indexOf(playingTrackId) : -1;
        add(playingIndex);
        for (const i of clusterLabels) add(i);
        return out;
    }, [field, hover, selectedIndex, playingTrackId, clusterLabels]);

    const labelRenderIdx = useMemo(() => {
        const viewW = gl.domElement.clientWidth || 1;
        const viewH = gl.domElement.clientHeight || 1;
        return resolveLabels(labelCandidates, (w) => {
            const v = new THREE.Vector3(w[0], w[1], w[2]).project(camera);
            // camera.project() yields NDC in [-1,1]^2, y-up; resolveLabels maps
            // that to device pixels internally, so hand the raw NDC through.
            return [v.x, v.y];
        }, viewW, viewH, MAX_LABELS);
    }, [labelCandidates]);

    // ── playing track pulse (reserved for a future animated ring) ───────────

    return (
        <>
            {/* Layer 1 — the ambient guitar-pick cosmos (terrain + hole + wisps) */}
            <Cosmos
                baselineGeo={baselineGeo}
                mat={mat}
                bgGeo={bgGeo}
                bgMat={bgMat}
                glow={glow}
                hole={hole}
                coreRef={coreRef}
            />

            {/* decorative region wayfinding labels (overview only) */}
            <RegionLabels show={!near} focusedId={activeZoneId} />

            {/* the baseline zone the search flew you to — a soft mood-toned reticle on the field */}
            {activeZoneId && (
                <Reticle
                    position={zoneWorldPos(
                        GALAXY_ZONES.find((z) => z.id === activeZoneId)!,
                    )}
                    color={
                        GALAXY_ZONES.find((z) => z.id === activeZoneId)!.dot
                    }
                    radius={5}
                    renderOrder={PEOPLE_ORDER}
                />
            )}

            {/* Layer 2 — THE REAL TRACKS, bright cloud, rendered over the hole */}
            <points
                data-testid="galaxy-track-field"
                geometry={starGeo}
                material={mat}
                renderOrder={PEOPLE_ORDER}
                onClick={(e) => {
                    e.stopPropagation();
                    const idx = e.index;
                    if (idx !== undefined && idx >= 0 && idx < field.userIds.length) {
                        onPick(idx);
                    }
                }}
                onPointerMissed={onBackgroundClick}
            />

            {/* invisible pick plane feeding the quadtree (tracks only) */}
            <mesh
                rotation-x={-Math.PI / 2}
                onPointerMove={onMove}
                onPointerOut={onOut}
                onPointerDown={onDown}
                onPointerUp={onUpWithDbl}
                onContextMenu={onContextMenu}
            >
                <planeGeometry args={[DISC_RADIUS * 2.8, DISC_RADIUS * 2.8]} />
                <meshBasicMaterial
                    transparent
                    opacity={0}
                    depthWrite={false}
                />
            </mesh>

            {/* hover reticle — the hovered track */}
            {hover != null && (
                <Reticle
                    position={pos3(field.pos, hover)}
                    color="#e8d6ad"
                    radius={1.7}
                    renderOrder={PEOPLE_ORDER}
                />
            )}
            {/* selection focus — the picked star, lit by the shader glow.
                There is no "you" star in a tracks galaxy, and no connecting
                thread: the rig drew a thread between two people; a track map
                has only one focal point. */}
            {selectedIndex >= 0 && (
                <>
                    <Reticle
                        position={pos3(field.pos, selectedIndex)}
                        color="#fff"
                        radius={2.4}
                        renderOrder={PEOPLE_ORDER}
                    />
                    <Reticle
                        position={pos3(field.pos, selectedIndex)}
                        color={AMBER}
                        radius={3.2}
                        renderOrder={PEOPLE_ORDER}
                    />
                </>
            )}

            {/* labels — at most MAX_LABELS, chosen by presentation priority
                (selected > hover > playing > nearest) and culled when their
                screen rectangles collide, so the pile the operator reported
                cannot recur. None show by default. */}
            {showLabels &&
                labelRenderIdx.map((ci) => {
                    const cand = labelCandidates[ci];
                    const dot =
                        cand.id === selectedTrackId
                            ? AMBER
                            : cand.id === String(hover ?? "")
                              ? "#fff"
                              : "#d8cfe6";
                    return (
                        <GalaxyLabel
                            key={cand.id}
                            position={cand.world}
                            name={cand.name}
                            dot={dot}
                        />
                    );
                })}

            <OrbitControls
                ref={controls as unknown as RefObject<ComponentRef<typeof OrbitControls>>}
                target={[0, 0, 0]}
                enablePan={false}
                enableDamping
                dampingFactor={0.08}
                autoRotate={!near}
                autoRotateSpeed={0.06}
                minDistance={22}
                maxDistance={160}
                minPolarAngle={0.26}
                maxPolarAngle={0.98}
            />

            <EffectComposer>
                <Bloom
                    mipmapBlur
                    luminanceThreshold={0.66}
                    luminanceSmoothing={0.32}
                    intensity={0.26}
                />
                <Noise
                    blendFunction={BlendFunction.OVERLAY}
                    opacity={0.08}
                />
                <Vignette eskil={false} offset={0.22} darkness={0.82} />
            </EffectComposer>
        </>
    );
}

// ── field builder: Layer 1 (ambient) + Layer 2 (real tracks) + quadtree ──────
//
// Same pattern as the rig's useGalaxyField, but Layer 2 is every track
// (not just "you + matches"). The track's real UMAP (x,y) is placed on the
// disc; y (mood PCA) is the vertical.
function useTrackGalaxyField(
    tracks: MapTrack[],
    radius: number,
) {
    const galaxy = useMemo(() => {
        // ── Layer 1: decorative ambient terrain ────────────────────────────
        // Reuse the rig's ambientBaseline which reads pos + color from the
        // layout. It adds the fine-star look (bright few / faint many,
        // twinkle, sparkle) and the sector attribute.
        const layout = buildTrackGalaxy(
            { count: tracks.length, radius: DISC_RADIUS },
            tracks,
        );
        const baselineGeo = buildBaselineGeometry({
            count: layout.count,
            pos: layout.pos,
            color: layout.color,
        });

        // ── Layer 2: every track is a real pickable star ────────────────────
        const count = tracks.length;
        const pos = layout.pos; // shared xyz
        const xs = new Float32Array(count);
        const zs = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            xs[i] = pos[i * 3];
            zs[i] = pos[i * 3 + 2];
        }

        // Star attributes the shader expects.
        const colors = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const phase = new Float32Array(count);
        const twAmp = new Float32Array(count);
        const spark = new Float32Array(count);
        // Tracks are never decorative-sector members -> -1 exempts them from
        // the explore-a-vibe glow (matches rig's real-person sector = -1).
        const sector = new Float32Array(count).fill(-1);
        // Each track's own index for the selection-focus uniform.
        const index = new Float32Array(count);
        for (let i = 0; i < count; i++) index[i] = i;

        // Base colour: the layout's OKLab mood colour (slightly lifted so
        // real tracks read bright against the ambient field).
        for (let i = 0; i < count; i++) {
            colors[i * 3] = layout.color[i * 3];
            colors[i * 3 + 1] = layout.color[i * 3 + 1];
            colors[i * 3 + 2] = layout.color[i * 3 + 2];
        }

        // ── quadtree over the disc plane (x, z) for O(log n) picking ────────
        const quad = new QuadTree(
            -radius * 1.4,
            -radius * 1.4,
            radius * 1.4,
            radius * 1.4,
            8,
        );
        for (let i = 0; i < count; i++) {
            quad.insert({ x: xs[i], z: zs[i], i });
        }

        const starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        starGeo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
        starGeo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
        starGeo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
        starGeo.setAttribute("aTwAmp", new THREE.BufferAttribute(twAmp, 1));
        starGeo.setAttribute("aSpark", new THREE.BufferAttribute(spark, 1));
        starGeo.setAttribute("aSector", new THREE.BufferAttribute(sector, 1));
        starGeo.setAttribute("aIndex", new THREE.BufferAttribute(index, 1));

        return {
            field: {
                pos,
                xs,
                zs,
                userIds: tracks.map((t) => t.id),
                titles: tracks.map(
                    (t) => `${t.title} — ${t.artist}`,
                ),
                // Selection focus falls back to index 0 (the first track) when
                // nothing is picked, so the "you" star is gone from the tree.
                focusFallbackIndex: 0,
            },
            starGeo,
            quad,
            baselineGeo,
        };
    }, [tracks, radius]);

    // r3f only auto-disposes JSX-declared objects; both geometries are built
    // imperatively — free them on unmount / field rebuild.
    useEffect(() => {
        const { starGeo, baselineGeo } = galaxy;
        return () => {
            starGeo.dispose();
            baselineGeo.dispose();
        };
    }, [galaxy]);

    return galaxy;
}

// ── exported scene + Canvas (dpr cap 1.5) ────────────────────────
export function GalaxyScene(props: GalaxySceneProps) {
    return (
        <Canvas
            camera={{
                position: CAM_POSITION,
                fov: CAM_FOV,
                near: 0.1,
                far: 600,
            }}
            gl={{
                antialias: true,
                alpha: true,
                powerPreference: "high-performance",
            }}
            dpr={[1, 1.5]}
            style={{ background: "#000000" }}
        >
            <Scene {...props} />
        </Canvas>
    );
}

// Re-export the zone definitions so the page can wire zone flies later.
export { GALAXY_ZONES, zoneWorldPos };
