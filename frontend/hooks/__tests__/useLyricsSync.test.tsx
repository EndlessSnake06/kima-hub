/**
 * State-machine tests for useLyricsSync.
 *
 * Tests the critical invariant: isLoading must be true from the very first
 * render when trackId is present, avoiding the false-empty flash.
 * House anti-pattern documented at useMediaQuery.ts:9.
 *
 * Approach: read the hook value into an array on every render, so we can
 * verify the FIRST value in the sequence is isLoading=true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import React, { createContext, useContext } from "react";

// ---------------------------------------------------------------------------
// Mock contexts
// ---------------------------------------------------------------------------

type PlaybackState = Record<string, unknown>;
type TrackIdRef = { id: string | null };
type AudioStateState = { currentTrack: TrackIdRef | null };

const PlaybackCtx = createContext<PlaybackState>({});
const AudioCtx = createContext<AudioStateState>({ currentTrack: null });

vi.mock("@/lib/audio-playback-context", () => ({
    useAudioPlayback: () => useContext(PlaybackCtx),
}));

vi.mock("@/lib/audio-state-context", () => ({
    useAudioState: () => useContext(AudioCtx),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock API requires flexible return types for tests
type MockApi = { getTrackLyrics: ReturnType<typeof vi.fn> } & Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (...args: any[]) => any
>;
const mockApi = { getTrackLyrics: vi.fn() } as unknown as MockApi;
vi.mock("@/lib/api", () => ({ api: mockApi }));

const { useLyricsSync } = await import("@/hooks/useLyricsSync");

// ---------------------------------------------------------------------------
// Test component: pushes every render's values into an array.
// ---------------------------------------------------------------------------

function LyricStateLog({
    results,
}: {
    results: React.MutableRefObject<
        { isLoading: boolean; hasLyrics: boolean; isSynced: boolean }[]
    >;
}) {
    const state = useLyricsSync();
    // Push every render — the first value is the first render.
    results.current.push({
        isLoading: state.isLoading,
        hasLyrics: state.hasLyrics,
        isSynced: state.isSynced,
    });
    return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RenderState = { isLoading: boolean; hasLyrics: boolean; isSynced: boolean };

async function createTree(): Promise<{
    resultsRef: React.MutableRefObject<RenderState[]>;
    root: Root;
    div: HTMLDivElement;
}> {
    const div = document.createElement("div");
    div.id = "test-root";
    document.body.appendChild(div);
    const root = createRoot(div);
    const resultsRef = { current: [] } as React.MutableRefObject<RenderState[]>;
    return { resultsRef, root, div };
}

async function teardown(resultsRef: React.MutableRefObject<RenderState[]>, root: Root, div: HTMLDivElement) {
    root.unmount();
    div.remove();
    resultsRef.current = [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLyricsSync -- loading state machine", () => {
    beforeEach(() => {
        mockApi.getTrackLyrics.mockReset();
    });

    it("mounts with trackId => isLoading=true from first render (no false-empty flash)", async () => {
        const { resultsRef, root, div } = await createTree();

        mockApi.getTrackLyrics.mockResolvedValue({
            plainLyrics: null, syncedLyrics: null, source: "",
        });

        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-abc" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        // resultsRef.current[0] is the FIRST render's value.
        expect(resultsRef.current.length).toBeGreaterThanOrEqual(1);
        expect(resultsRef.current[0].isLoading).toBe(true);

        // Wait for API + any additional renders to settle.
        await act(async () => { await new Promise<void>((r) => setTimeout(r, 100)); });

        const last = resultsRef.current[resultsRef.current.length - 1];
        expect(last.isLoading).toBe(false);
        expect(last.hasLyrics).toBe(false);

        await teardown(resultsRef, root, div);
    });

    it("mounts with no trackId => isLoading=false", async () => {
        const { resultsRef, root, div } = await createTree();

        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: null }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        expect(resultsRef.current.length).toBeGreaterThanOrEqual(1);
        expect(resultsRef.current[0].isLoading).toBe(false);

        await teardown(resultsRef, root, div);
    });

    it("transitions to loaded after fetch resolves (synced lyrics)", async () => {
        const { resultsRef, root, div } = await createTree();

        mockApi.getTrackLyrics.mockResolvedValueOnce({
            plainLyrics: null, syncedLyrics: "[00:00]Hello\n[00:02]World", source: "lrclib",
        });

        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-synced" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        // First render: loading.
        expect(resultsRef.current[0].isLoading).toBe(true);
        expect(resultsRef.current[0].hasLyrics).toBe(false);

        // Wait for API.
        await act(async () => { await new Promise<void>((r) => setTimeout(r, 300)); });

        const last = resultsRef.current[resultsRef.current.length - 1];
        expect(last.isLoading).toBe(false);
        expect(last.hasLyrics).toBe(true);
        expect(last.isSynced).toBe(true);

        await teardown(resultsRef, root, div);
    });

    it("transitions to hasLyrics=false after fetch resolves (no lyrics)", async () => {
        const { resultsRef, root, div } = await createTree();

        mockApi.getTrackLyrics.mockResolvedValueOnce({
            plainLyrics: null, syncedLyrics: null, source: "none",
        });

        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-none" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        await act(async () => { await new Promise<void>((r) => setTimeout(r, 300)); });

        const last = resultsRef.current[resultsRef.current.length - 1];
        expect(last.isLoading).toBe(false);
        expect(last.hasLyrics).toBe(false);

        await teardown(resultsRef, root, div);
    });

    it("transitions to loading again on track change, then loaded", async () => {
        // Create a persistent component for track changes.
        const resultsRef = { current: [] } as React.MutableRefObject<RenderState[]>;

        mockApi.getTrackLyrics
            .mockResolvedValueOnce({ plainLyrics: "Line 1\nLine 2", syncedLyrics: null, source: "plain" })
            .mockResolvedValueOnce({ plainLyrics: null, syncedLyrics: "[00:00]New\n[00:02]Track", source: "lrclib" });

        const div = document.createElement("div");
        div.id = "test-root";
        document.body.appendChild(div);
        const root = createRoot(div);

        // Mount with track-a.
        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-a" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        await act(async () => { await new Promise<void>((r) => setTimeout(r, 200)); });

        // After track-a: loading=false, hasLyrics=true.
        expect(resultsRef.current[resultsRef.current.length - 1].isLoading).toBe(false);
        expect(resultsRef.current[resultsRef.current.length - 1].hasLyrics).toBe(true);

        // Change track.
        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-b" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        await act(async () => { await new Promise<void>((r) => setTimeout(r, 300)); });

        const last = resultsRef.current[resultsRef.current.length - 1];
        expect(last.isLoading).toBe(false);
        expect(last.hasLyrics).toBe(true);
        expect(last.isSynced).toBe(true);

        root.unmount();
        div.remove();
        resultsRef.current = [];
    });

    it("transitions to loading=false when api rejects", async () => {
        const { resultsRef, root, div } = await createTree();

        mockApi.getTrackLyrics.mockRejectedValueOnce(new Error("network fail"));

        await act(async () => {
            root.render(
                <PlaybackCtx.Provider value={{ currentTime: 0 }}>
                    <AudioCtx.Provider value={{ currentTrack: { id: "track-error" } }}>
                        <LyricStateLog results={resultsRef} />
                    </AudioCtx.Provider>
                </PlaybackCtx.Provider>
            );
        });

        await act(async () => { await new Promise<void>((r) => setTimeout(r, 300)); });

        const last = resultsRef.current[resultsRef.current.length - 1];
        expect(last.isLoading).toBe(false);
        expect(last.hasLyrics).toBe(false);

        await teardown(resultsRef, root, div);
    });
});
