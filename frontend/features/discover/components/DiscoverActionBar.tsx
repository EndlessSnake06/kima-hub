"use client";

import { Play, Pause, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { DiscoverPlaylist } from "../types";

interface DiscoverActionBarProps {
    playlist: DiscoverPlaylist | null;
    isPlaylistPlaying: boolean;
    isPlaying: boolean;
    onPlayToggle: () => void;
    isGenerating: boolean;
    onCancelGeneration?: () => void;
}

export function DiscoverActionBar({
    playlist,
    isPlaylistPlaying,
    isPlaying,
    onPlayToggle,
    isGenerating,
    onCancelGeneration,
}: DiscoverActionBarProps) {
    const canPlay = !!playlist && playlist.tracks.length > 0;
    const canCancel = isGenerating && !!onCancelGeneration;
    if (!canPlay && !canCancel) return null;

    return (
        <div className="page-shell pb-6 flex items-center gap-4">
            {canPlay && (
                <button
                    onClick={onPlayToggle}
                    disabled={isGenerating}
                    aria-label={isPlaylistPlaying && isPlaying ? "Pause" : "Play Discover Weekly"}
                    className="h-12 w-12 flex items-center justify-center rounded-lg bg-brand hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isPlaylistPlaying && isPlaying ?
                        <Pause className="w-5 h-5 fill-current text-black" />
                    :   <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                    }
                </button>
            )}

            {canCancel && (
                <Button variant="secondary" onClick={onCancelGeneration} className="h-12">
                    <X className="w-4 h-4" />
                    Cancel
                </Button>
            )}
        </div>
    );
}
