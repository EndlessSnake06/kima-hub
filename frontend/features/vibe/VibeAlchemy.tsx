"use client";

import { useState, useCallback } from "react";
import { X, Plus, Minus, FlaskConical, Search, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import type { LibraryIndex } from "./librarySearch";
import { useTrackFinder } from "./useTrackFinder";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track, VibeOperation } from "@/lib/audio-state-context";

interface VibeAlchemyProps {
    library: LibraryIndex;
    onHighlight: (ids: Set<string>) => void;
    onClose: () => void;
}

interface SelectedTrack {
    id: string;
    title: string;
    artist: string;
}

export function VibeAlchemy({ library, onHighlight, onClose }: VibeAlchemyProps) {
    const { replaceOperation } = useAudioControls();
    const [addTracks, setAddTracks] = useState<SelectedTrack[]>([]);
    const [subtractTracks, setSubtractTracks] = useState<SelectedTrack[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [addingTo, setAddingTo] = useState<"add" | "subtract">("add");
    const [results, setResults] = useState<
        Array<{
            id: string;
            title: string;
            duration: number;
            similarity: number;
            album: { id: string; title: string; coverUrl: string | null };
            artist: { id: string; name: string };
        }>
    >([]);
    const [computeError, setComputeError] = useState<string | null>(null);

    const finder = useTrackFinder(library, searchQuery, true);

    const addToColumn = useCallback(
        (track: { id: string; title: string; artist: { name: string } }) => {
            const selected: SelectedTrack = {
                id: track.id,
                title: track.title,
                artist: track.artist.name,
            };
            if (addingTo === "add") {
                setAddTracks((prev) =>
                    prev.some((t) => t.id === track.id)
                        ? prev
                        : [...prev, selected],
                );
            } else {
                setSubtractTracks((prev) =>
                    prev.some((t) => t.id === track.id)
                        ? prev
                        : [...prev, selected],
                );
            }
            setSearchQuery("");
        },
        [addingTo],
    );

    const removeTrack = useCallback(
        (id: string, column: "add" | "subtract") => {
            if (column === "add")
                setAddTracks((prev) => prev.filter((t) => t.id !== id));
            else setSubtractTracks((prev) => prev.filter((t) => t.id !== id));
        },
        [],
    );

    const mutation = useMutation({
        mutationFn: () =>
            api.getVibeAlchemy(
                addTracks.map((t) => t.id),
                subtractTracks.map((t) => t.id),
                30,
            ),
        onSuccess: (result) => {
            setResults(result.tracks);
            onHighlight(new Set(result.tracks.map((t) => t.id)));
            setComputeError(null);
        },
        onError: () => {
            setResults([]);
            setComputeError("Failed to compute blend");
        },
    });

    const handlePlayResults = useCallback(() => {
        const playable: Track[] = results.map((t) => ({
            id: t.id,
            title: t.title,
            duration: t.duration,
            album: { title: t.album.title, coverArt: t.album.coverUrl ?? undefined, id: t.album.id },
            artist: { name: t.artist.name, id: t.artist.id },
        }));
        const op: VibeOperation = {
            type: 'blend',
            addTrackIds: addTracks.map((t) => t.id),
            subtractTrackIds: subtractTracks.map((t) => t.id),
            resultTrackIds: playable.map((t) => t.id),
        };
        replaceOperation(op, playable, 0);
    }, [results, addTracks, subtractTracks, replaceOperation]);

    return (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-(--z-scene) w-[calc(100vw-2rem)] sm:w-[480px] max-h-[70vh] vibe-glass rounded-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                    <FlaskConical className="w-4 h-4" /> Blend
                </h3>
                <button
                    onClick={onClose}
                    className="text-[var(--text-muted)] hover:text-white"
                    aria-label="Close alchemy"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <button
                            onClick={() => setAddingTo("add")}
                            className={`text-xs mb-2 flex items-center gap-1 ${addingTo === "add" ? "text-success" : "text-[var(--text-muted)]"}`}
                            aria-pressed={addingTo === "add"}
                        >
                            <Plus className="w-3 h-3" /> More Like
                        </button>
                        {addTracks.map((t) => (
                            <div
                                key={t.id}
                                className="flex items-center gap-1 mb-1"
                            >
                                <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
                                    {t.title}
                                </span>
                                <button
                                    onClick={() => removeTrack(t.id, "add")}
                                    className="text-[var(--text-muted)] hover:text-white"
                                    aria-label={`Remove ${t.title}`}
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <div>
                        <button
                            onClick={() => setAddingTo("subtract")}
                            className={`text-xs mb-2 flex items-center gap-1 ${addingTo === "subtract" ? "text-danger-light" : "text-[var(--text-muted)]"}`}
                            aria-pressed={addingTo === "subtract"}
                        >
                            <Minus className="w-3 h-3" /> Less Like
                        </button>
                        {subtractTracks.map((t) => (
                            <div
                                key={t.id}
                                className="flex items-center gap-1 mb-1"
                            >
                                <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
                                    {t.title}
                                </span>
                                <button
                                    onClick={() =>
                                        removeTrack(t.id, "subtract")
                                    }
                                    className="text-[var(--text-muted)] hover:text-white"
                                    aria-label={`Remove ${t.title}`}
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="relative">
                    <label htmlFor="alchemy-search" className="sr-only">Search tracks for alchemy</label>
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
                    <input
                        id="alchemy-search"
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={`Search to add to "${addingTo === "add" ? "More Like" : "Less Like"}"...`}
                        className="w-full pl-8 pr-3 py-2 bg-white/8 border border-white/10 rounded-lg text-sm text-white placeholder-white/55 focus:outline-none focus:border-white/20"
                    />
                </div>

                {finder.items.length > 0 && (
                    <div className="max-h-32 overflow-y-auto border border-white/10 rounded-lg">
                        {finder.items.map((track) => (
                            <button
                                key={track.id}
                                onClick={() => addToColumn(track)}
                                className="w-full px-3 py-2 hover:bg-white/10 text-left"
                            >
                                <p className="text-sm text-[var(--text-primary)] truncate">{track.title}</p>
                                <p className="text-xs text-white/60 truncate">
                                    {track.artist.name}{track.via === "sound" ? " · sounds like it" : ""}
                                </p>
                            </button>
                        ))}
                    </div>
                )}
                {finder.searching && <p className="px-1 text-xs text-white/60" aria-live="polite">Searching…</p>}
                {finder.empty && (
                    <p className="px-1 text-xs text-white/60" aria-live="polite">
                        No track or artist matches &ldquo;{searchQuery.trim()}&rdquo;.
                    </p>
                )}

                <button
                    onClick={() => mutation.mutate()}
                    disabled={addTracks.length === 0 || mutation.isPending}
                    className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 disabled:opacity-30 rounded-lg text-sm text-[var(--text-primary)] hover:text-white flex items-center justify-center gap-2"
                >
                    <FlaskConical className="w-4 h-4" />{" "}
                    {mutation.isPending ? "Computing..." : "Blend"}
                </button>
                {computeError && <p className="text-xs text-danger-light/70 text-center mt-1">{computeError}</p>}
            </div>

            {results.length > 0 && (
                <div className="border-t border-white/10">
                    <div className="px-4 py-2">
                        <button
                            onClick={handlePlayResults}
                            className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-sm text-[var(--text-primary)] hover:text-white flex items-center justify-center gap-2"
                        >
                            <Play className="w-4 h-4" /> Play Result (
                            {results.length})
                        </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        {results.map((track, i) => (
                            <div
                                key={track.id}
                                className="px-4 py-2 hover:bg-white/5 flex items-center gap-3"
                            >
                                <span className="text-[var(--text-muted)] text-xs w-5 text-right">
                                    {i + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-[var(--text-primary)] truncate">
                                        {track.title}
                                    </p>
                                    <p className="text-xs text-[var(--text-muted)] truncate">
                                        {track.artist.name}
                                    </p>
                                </div>
                                <span className="text-xs text-[var(--text-muted)]">
                                    {Math.round(track.similarity * 100)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
