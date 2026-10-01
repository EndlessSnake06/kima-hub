"use client";

import { useState, useRef } from "react";
import { Play, Pause, Check, ArrowUpDown, CheckCircle, ChevronDown, ChevronUp } from "lucide-react";
import DOMPurify from "dompurify";
import { cn } from "@/lib/cn";
import { Episode } from "../types";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cascadeStyle } from "@/lib/motion";

interface EpisodeListProps {
    episodes: Episode[];
    sortOrder: "newest" | "oldest";
    onSortOrderChange: (order: "newest" | "oldest") => void;
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}

function EpisodeRow({
    episode,
    index,
    isCurrentEpisode,
    isPlaying,
    onPlayPause,
    onPlay,
    onMarkComplete,
}: {
    episode: Episode;
    index: number;
    isCurrentEpisode: boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}) {
    const lastTapRef = useRef<{ time: number; index: number }>({ time: 0, index: -1 });
    const [expanded, setExpanded] = useState(false);
    const isInProgress =
        episode.progress &&
        !episode.progress.isFinished &&
        episode.progress.currentTime > 0;
    const hasDescription = episode.description && episode.description.trim().length > 0;

    return (
        <div
            className={cn(
                "group relative rounded-lg transition-all",
                isCurrentEpisode
                    ? "bg-white/5"
                    : "border border-transparent hover:bg-white/[0.03] hover:border-white/5",
                "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
            )}
            style={{ "--i": index } as unknown as React.CSSProperties}
        >
            {/* Progress bar */}
            {episode.progress && episode.progress.progress > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-brand/60 transition-all"
                        style={{
                            width: `${episode.progress.progress}%`,
                        }}
                    />
                </div>
            )}

            <div
                data-track-index={index}
                onDoubleClick={() => {
                    if (isCurrentEpisode) {
                        onPlayPause(episode);
                    } else {
                        onPlay(episode);
                    }
                }}
                onTouchEnd={(e) => {
                    const idx = Number(e.currentTarget.dataset.trackIndex);
                    if (isNaN(idx)) return;
                    const now = Date.now();
                    if (now - lastTapRef.current.time < 300 && lastTapRef.current.index === idx) {
                        if (isCurrentEpisode) {
                            onPlayPause(episode);
                        } else {
                            onPlay(episode);
                        }
                        lastTapRef.current = { time: 0, index: -1 };
                    } else {
                        lastTapRef.current = { time: now, index: idx };
                    }
                }}
                className={cn(
                    "grid grid-cols-[40px_minmax(0,1fr)_auto_auto] md:grid-cols-[40px_minmax(200px,3fr)_minmax(100px,2fr)_auto_auto] gap-4 items-center px-3 py-2 rounded-lg transition-all group",
                    isCurrentEpisode ? "cursor-pointer" : "cursor-pointer"
                )}
            >
                {/* Number / Play/Pause */}
                <div className="flex items-center justify-center shrink-0">
                    {episode.progress?.isFinished ? (
                        <Check className="w-4 h-4 text-[var(--color-brand)]" />
                    ) : (
                        <>
                            <span
                                className={cn(
                                    "text-xs",
                                    isCurrentEpisode && isPlaying
                                        ? "hidden"
                                        : "group-hover:hidden",
                                    isCurrentEpisode
                                        ? "font-bold text-[var(--color-brand)]"
                                        : "text-[var(--text-muted)]"
                                )}
                            >
                                {index + 1}
                            </span>
                            {isCurrentEpisode && isPlaying ? (
                                <Pause
                                    className="w-4 h-4 text-[var(--color-brand)] cursor-pointer animate-pulse"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onPlayPause(episode);
                                    }}
                                />
                            ) : (
                                <Play
                                    className={cn(
                                        "w-4 h-4 cursor-pointer",
                                        isCurrentEpisode
                                            ? "text-[var(--color-brand)]"
                                            : "text-white hidden group-hover:block"
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onPlayPause(episode);
                                    }}
                                />
                            )}
                        </>
                    )}
                </div>

                {/* Episode Info (Title + metadata chips) */}
                <div className="min-w-0 overflow-hidden">
                    <h3
                        className={cn(
                            "font-bold truncate text-sm tracking-tight",
                            isCurrentEpisode ? "text-[var(--color-brand)]" : "text-white"
                        )}
                    >
                        {episode.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        {/* Status chip: finished */}
                        {episode.progress?.isFinished && (
                            <span className="inline-flex items-center t-eyebrow leading-none">
                                ✓&nbsp;Finished
                            </span>
                        )}
                        {/* Status chip: in-progress */}
                        {isInProgress && episode.progress && (
                            <span className="inline-flex items-center t-eyebrow leading-none text-[var(--color-brand)]">
                                {Math.floor(episode.progress.progress)}%
                            </span>
                        )}
                        {/* Meta: date */}
                        <span className="t-meta leading-none">{formatDate(episode.publishedAt)}</span>
                        {/* Meta: season/episode */}
                        {episode.season && (
                            <>
                                <span className="t-meta leading-none">|</span>
                                <span className="t-meta leading-none">S{episode.season}</span>
                            </>
                        )}
                        {episode.episodeNumber && (
                            <>
                                <span className="t-meta leading-none">|</span>
                                <span className="t-meta leading-none">E{episode.episodeNumber}</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Duration */}
                <span className="t-meta shrink-0 text-right">
                    {formatDuration(episode.duration)}
                </span>

                {/* Expand description */}
                {hasDescription && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(!expanded);
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-[var(--text-muted)] hover:text-white/60 transition-all shrink-0"
                    >
                        {expanded ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                        )}
                    </button>
                )}

                {/* Complete Button */}
                {onMarkComplete && !episode.progress?.isFinished && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onMarkComplete(episode.id, episode.duration);
                        }}
                        className="opacity-0 group-hover:opacity-100 group-hover:translate-y-0 translate-y-1 transition-[opacity,transform] duration-150 p-1.5 rounded-lg hover:bg-white/10 shrink-0"
                        title="Mark as complete"
                    >
                        <CheckCircle className="w-4 h-4 text-[var(--text-muted)] hover:text-[var(--color-brand)] transition-colors" />
                    </button>
                )}

                {/* Expanded description */}
                {expanded && hasDescription && (
                    <div className="col-span-full px-3 pb-3 pt-0">
                        <div
                            className="text-xs text-[var(--text-muted)] leading-relaxed max-w-3xl line-clamp-6"
                            dangerouslySetInnerHTML={{
                                __html: DOMPurify.sanitize(episode.description || ""),
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export function EpisodeList({
    episodes,
    sortOrder,
    onSortOrderChange,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
    onPlay,
    onMarkComplete,
}: EpisodeListProps) {
    const sortButton = (
        <button
            onClick={() =>
                onSortOrderChange(
                    sortOrder === "newest" ? "oldest" : "newest"
                )
            }
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs tabular-nums text-[var(--text-secondary)] hover:text-white transition-all"
        >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {sortOrder === "newest" ? "Newest" : "Oldest"}
        </button>
    );

    return (
        <section>
            <SectionHeader title="All Episodes" action={sortButton} type="podcast" />

            {/* Table header (desktop only) */}
            <div className="hidden md:grid grid-cols-[40px_minmax(200px,3fr)_minmax(100px,2fr)_auto_auto] gap-4 px-3 py-2 text-xs text-[var(--text-muted)] border-b border-white/10 mb-1">
                <span className="text-center">#</span>
                <span>Title</span>
                <span className="text-right">Duration</span>
                <span className="w-8" />
                <span className="w-8" />
            </div>

            {/* Mobile column labels */}
            <div className="md:hidden grid grid-cols-[40px_1fr_auto_auto] gap-4 px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                <span>#</span>
                <span>Title</span>
                <span className="text-right">Duration</span>
                <span className="w-8" />
            </div>

            <div className="space-y-0.5" style={cascadeStyle(episodes.length)}>
                {episodes.map((episode, index) => (
                    <EpisodeRow
                        key={episode.id}
                        episode={episode}
                        index={index}
                        isCurrentEpisode={isEpisodePlaying(episode.id)}
                        isPlaying={isPlaying}
                        onPlayPause={onPlayPause}
                        onPlay={onPlay}
                        onMarkComplete={onMarkComplete}
                    />
                ))}
            </div>
        </section>
    );
}
