"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAudioState, useAudioControls } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";

import {
    Music,
    Play,
    X,
    Trash2,
    ListMusic,
    ChevronUp,
    ChevronDown,
} from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";

export default function QueuePage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { queue, currentTrack, currentIndex, setQueue } = useAudioState();
    const { playTracks, removeFromQueue, clearQueue } = useAudioControls();
    const [confirmClear, setConfirmClear] = useState(false);

    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, router]);

    const handleClearQueue = () => {
        clearQueue();
    };

    const handleRemoveTrack = (index: number) => {
        removeFromQueue(index);
    };

    const handlePlayFromQueue = (index: number) => {
        playTracks(queue, index);
    };

    const handleMoveUp = (index: number) => {
        if (index <= currentIndex + 1) return;
        setQueue((prev) => {
            const newQueue = [...prev];
            [newQueue[index], newQueue[index - 1]] = [
                newQueue[index - 1],
                newQueue[index],
            ];
            return newQueue;
        });
    };

    const handleMoveDown = (index: number) => {
        if (index >= queue.length - 1 || index <= currentIndex) return;
        setQueue((prev) => {
            const newQueue = [...prev];
            [newQueue[index], newQueue[index + 1]] = [
                newQueue[index + 1],
                newQueue[index],
            ];
            return newQueue;
        });
    };

    if (!isAuthenticated) {
        return null;
    }

    // Split queue into current, next up, and previous
    const previousTracks = queue.slice(0, currentIndex);
    const nextTracks = queue.slice(currentIndex + 1);

    return (
        <div className="min-h-screen">
            <PageHeader
                eyebrow="Playing next"
                title="Queue"
                description={`${queue.length} ${queue.length === 1 ? "track" : "tracks"}`}
                actions={
                    queue.length > 0 && (
                        <Button variant="secondary" onClick={() => setConfirmClear(true)}>
                            <Trash2 className="w-4 h-4" />
                            Clear queue
                        </Button>
                    )
                }
            />

            <div className="page-shell pb-24">
                <div className="max-w-4xl space-y-6">
                    {queue.length === 0 && (
                        <EmptyState
                            icon={<ListMusic />}
                            title="No tracks in queue"
                            description="Start playing music to see your queue here"
                            action={{
                                label: "Browse Library",
                                onClick: () => router.push("/collection"),
                            }}
                        />
                    )}

                    {currentTrack && (
                        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4 md:p-6">
                            <h2 className="text-xl font-semibold text-white mb-4">
                                Now Playing
                            </h2>
                            <Card>
                                <div className="flex items-center gap-4 p-4 bg-[var(--bg-hover)] border-l-2 border-brand">
                                    <div className="relative flex-shrink-0 w-16 h-16">
                                        {currentTrack.album?.coverArt ? (
                                            <CachedImage
                                                src={api.getCoverArtUrl(
                                                    currentTrack.album.coverArt,
                                                    100
                                                )}
                                                alt={currentTrack.album.title}
                                                fill
                                                sizes="64px"
                                                className="object-cover rounded-sm"
                                            />
                                        ) : (
                                            <div className="w-16 h-16 bg-[var(--bg-primary)] rounded-sm flex items-center justify-center">
                                                <Music className="w-6 h-6 text-[var(--text-muted)]" />
                                            </div>
                                        )}
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <Play className="w-6 h-6 text-brand fill-brand animate-pulse" />
                                        </div>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-sm font-medium text-brand truncate">
                                            {currentTrack.displayTitle ??
                                                currentTrack.title}
                                        </h3>
                                        <p className="text-sm text-[var(--text-secondary)] truncate">
                                            {currentTrack.artist?.name}
                                        </p>
                                        <p className="text-xs text-[var(--text-muted)] truncate">
                                            {currentTrack.album?.title}
                                        </p>
                                    </div>
                                    <div className="text-sm text-[var(--text-muted)]">
                                        {currentTrack.duration
                                            ? `${Math.floor(
                                                  currentTrack.duration / 60
                                              )}:${(currentTrack.duration % 60)
                                                  .toString()
                                                  .padStart(2, "0")}`
                                            : ""}
                                    </div>
                                </div>
                            </Card>
                        </section>
                    )}

                    {nextTracks.length > 0 && (
                        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4 md:p-6">
                            <h2 className="text-xl font-semibold text-white mb-4">
                                Next Up ({nextTracks.length})
                            </h2>
                            <Card>
                                <div className="divide-y divide-[#1c1c1c]">
                                    {nextTracks.map((track, idx) => {
                                        const queueIndex = currentIndex + 1 + idx;
                                        return (
                                            <div
                                                key={`${track.id}-${queueIndex}`}
                                                className="flex items-center gap-4 p-4 hover:bg-[var(--bg-hover)] transition-colors group"
                                            >
                                                <div className="relative flex-shrink-0 w-12 h-12">
                                                    {track.album?.coverArt ? (
                                                        <CachedImage
                                                            src={api.getCoverArtUrl(
                                                                track.album
                                                                    .coverArt,
                                                                100
                                                            )}
                                                            alt={track.album.title}
                                                            fill
                                                            sizes="48px"
                                                            className="object-cover rounded-sm"
                                                        />
                                                    ) : (
                                                        <div className="w-12 h-12 bg-[var(--bg-primary)] rounded-sm flex items-center justify-center">
                                                            <Music className="w-5 h-5 text-[var(--text-muted)]" />
                                                        </div>
                                                    )}
                                                </div>

                                                <div className="flex-1 min-w-0">
                                                    <h3 className="text-sm font-medium text-white truncate">
                                                        {track.displayTitle ??
                                                            track.title}
                                                    </h3>
                                                    <p className="text-sm text-[var(--text-secondary)] truncate">
                                                        {track.artist?.name}
                                                    </p>
                                                </div>

                                                <div className="text-sm text-[var(--text-muted)]">
                                                    {track.duration
                                                        ? `${Math.floor(
                                                              track.duration / 60
                                                          )}:${(track.duration % 60)
                                                              .toString()
                                                              .padStart(2, "0")}`
                                                        : ""}
                                                </div>

                                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch-reveal transition-opacity">
                                                    <button
                                                        onClick={() =>
                                                            handleMoveUp(queueIndex)
                                                        }
                                                        disabled={
                                                            queueIndex <=
                                                            currentIndex + 1
                                                        }
                                                        className="p-2.5 min-h-[44px] min-w-[44px] hover:bg-[var(--bg-primary)] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
                                                        aria-label={`Move ${track.displayTitle ?? track.title} up`}
                                                    >
                                                        <ChevronUp className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            handleMoveDown(
                                                                queueIndex
                                                            )
                                                        }
                                                        disabled={
                                                            queueIndex >=
                                                            queue.length - 1
                                                        }
                                                        className="p-2.5 min-h-[44px] min-w-[44px] hover:bg-[var(--bg-primary)] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
                                                        aria-label={`Move ${track.displayTitle ?? track.title} down`}
                                                    >
                                                        <ChevronDown className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            handlePlayFromQueue(
                                                                queueIndex
                                                            )
                                                        }
                                                        className="p-2.5 min-h-[44px] min-w-[44px] hover:bg-[var(--bg-primary)] rounded-md transition-colors flex items-center justify-center"
                                                        aria-label={`Play ${track.displayTitle ?? track.title}`}
                                                    >
                                                        <Play className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            handleRemoveTrack(
                                                                queueIndex
                                                            )
                                                        }
                                                        className="p-2.5 min-h-[44px] min-w-[44px] hover:bg-danger/10 rounded-md transition-colors text-danger-light flex items-center justify-center"
                                                        aria-label={`Remove ${track.displayTitle ?? track.title} from queue`}
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </Card>
                        </section>
                    )}

                    {previousTracks.length > 0 && (
                        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4 md:p-6">
                            <h2 className="text-xl font-semibold text-white mb-4">
                                Previously Played ({previousTracks.length})
                            </h2>
                            <Card>
                                <div className="divide-y divide-[#1c1c1c]">
                                    {previousTracks.map((track, idx) => (
                                        <div
                                            key={`${track.id}-${idx}`}
                                            className="flex items-center gap-4 p-4 hover:bg-[var(--bg-hover)] transition-colors group opacity-50"
                                        >
                                            <div className="relative flex-shrink-0 w-12 h-12">
                                                {track.album?.coverArt ? (
                                                    <CachedImage
                                                        src={api.getCoverArtUrl(
                                                            track.album.coverArt,
                                                            100
                                                        )}
                                                        alt={track.album.title}
                                                        fill
                                                        sizes="48px"
                                                        className="object-cover rounded-sm"
                                                    />
                                                ) : (
                                                    <div className="w-12 h-12 bg-[var(--bg-primary)] rounded-sm flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-[var(--text-muted)]" />
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-sm font-medium text-white truncate">
                                                    {track.title}
                                                </h3>
                                                <p className="text-sm text-[var(--text-secondary)] truncate">
                                                    {track.artist?.name}
                                                </p>
                                            </div>

                                            <div className="text-sm text-[var(--text-muted)]">
                                                {track.duration
                                                    ? `${Math.floor(
                                                          track.duration / 60
                                                      )}:${(track.duration % 60)
                                                          .toString()
                                                          .padStart(2, "0")}`
                                                    : ""}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </Card>
                        </section>
                    )}
                </div>
            </div>

            <ConfirmDialog
                isOpen={confirmClear}
                onClose={() => setConfirmClear(false)}
                onConfirm={handleClearQueue}
                title="Clear the queue?"
                message={`This removes ${queue.length === 1 ? "the only track" : `all ${queue.length} tracks`} from the queue.`}
                confirmText="Clear queue"
                variant="danger"
            />
        </div>
    );
}
