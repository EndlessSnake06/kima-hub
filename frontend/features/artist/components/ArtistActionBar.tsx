import { Play, Pause, Shuffle, Download, Radio } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Album, ArtistSource } from "../types";

interface ArtistActionBarProps {
    albums: Album[];
    source: ArtistSource | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAll: () => void;
    onStartRadio: () => void;
    isPendingDownload: boolean;
    isPlaying: boolean;
    isPlayingThisArtist: boolean;
    onPause: () => void;
}

export function ArtistActionBar({
    albums,
    source,
    onPlayAll,
    onShuffle,
    onDownloadAll,
    onStartRadio,
    isPendingDownload,
    isPlaying,
    isPlayingThisArtist,
    onPause,
}: ArtistActionBarProps) {
    const availableAlbums = albums.filter(
        (album) => album.availability !== "unavailable"
    );
    const showDownloadAll = source === "discovery" || availableAlbums.length > 0;
    const showPause = isPlaying && isPlayingThisArtist;
    const showRadio = source === "library";

    const handlePlayPauseClick = () => {
        if (showPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    return (
        <div className="flex items-center gap-4">
            <button
                onClick={handlePlayPauseClick}
                aria-label={showPause ? "Pause" : "Play all"}
                className="h-12 w-12 rounded-full flex items-center justify-center transition-all hover:scale-105 bg-brand"
            >
                {showPause ? (
                    <Pause className="w-5 h-5 fill-current text-black" />
                ) : (
                    <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                )}
            </button>

            <button
                onClick={onShuffle}
                className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-all"
                title="shuffle play"
            >
                <Shuffle className="w-5 h-5" />
            </button>

            {/* Radio Button - Only for library artists */}
            {showRadio && (
                <button
                    onClick={onStartRadio}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-all"
                    title="start artist radio"
                >
                    <Radio className="w-5 h-5" />
                </button>
            )}

            {showDownloadAll && (
                <button
                    onClick={onDownloadAll}
                    disabled={isPendingDownload}
                    className={cn(
                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                        isPendingDownload
                            ? "bg-white/5 text-[var(--text-secondary)] cursor-not-allowed"
                            : "bg-white/5 hover:bg-white/10 text-[var(--text-primary)] hover:text-white"
                    )}
                >
                    <Download className="w-4 h-4" />
                    <span className="hidden sm:inline">
                        {isPendingDownload ? "Downloading..." : "Download All"}
                    </span>
                </button>
            )}
        </div>
    );
}
