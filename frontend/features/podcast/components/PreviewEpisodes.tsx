"use client";

import DOMPurify from "dompurify";
import { Plus, Loader2 } from "lucide-react";
import { PodcastPreview } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { SectionHeader } from "@/components/ui/SectionHeader";

interface PreviewEpisodesProps {
    previewData: PodcastPreview;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    onSubscribe: () => void;
}

export function PreviewEpisodes({
    previewData,
    isSubscribing,
    onSubscribe,
}: PreviewEpisodesProps) {
    const hasEpisodes =
        previewData.previewEpisodes &&
        previewData.previewEpisodes.length > 0;

    return (
        <section>
            <SectionHeader title="Latest Episodes" type="podcast" />

            {hasEpisodes ? (
                <>
                    <div className="space-y-0.5">
                        {previewData.previewEpisodes!.map((episode, index) => (
                            <div
                                key={index}
                                className="flex items-center gap-4 px-3 py-2 rounded-lg opacity-50 cursor-not-allowed"
                            >
                                <div className="w-8 flex items-center justify-center shrink-0">
                                    <span className="text-xs tabular-nums text-[var(--text-muted)]">
                                        {index + 1}
                                    </span>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="font-bold truncate text-sm text-white tracking-tight">
                                        {episode.title}
                                    </h3>
                                    <div className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)]">
                                        <span>{formatDate(episode.publishedAt)}</span>
                                        {episode.duration > 0 && (
                                            <>
                                                <span className="text-[var(--text-muted)]">|</span>
                                                <span>{formatDuration(episode.duration)}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Subscribe overlay */}
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0a]/80 to-[#0a0a0a] flex items-end justify-center pb-8 pointer-events-none">
                        <button
                            onClick={onSubscribe}
                            disabled={isSubscribing}
                            className="flex items-center gap-2 pointer-events-auto h-10 px-5 rounded-lg bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] transition-all font-bold text-sm text-black disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
                        >
                            {isSubscribing ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>Subscribing</span>
                                </>
                            ) : (
                                <>
                                    <Plus className="w-4 h-4" />
                                    <span>Subscribe to Unlock All Episodes</span>
                                </>
                            )}
                        </button>
                    </div>
                </>
            ) : (
                <div className="relative overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-8 text-center">
                    <p className="text-xs text-[var(--text-muted)] mb-4">
                        No episodes available for preview
                    </p>
                    <button
                        onClick={onSubscribe}
                        disabled={isSubscribing}
                        className="flex items-center gap-2 mx-auto h-10 px-5 rounded-lg bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] transition-all font-bold text-sm text-black disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
                    >
                        {isSubscribing ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>Subscribing</span>
                            </>
                        ) : (
                            <>
                                <Plus className="w-4 h-4" />
                                <span>Subscribe</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* About Section */}
            {previewData.description && (
                <div className="mt-8">
                    <SectionHeader title="About" type="podcast" />
                    <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[var(--bg-primary)] p-4">
                        <div
                            className="prose prose-invert prose-sm max-w-none text-[var(--text-secondary)] max-w-3xl text-xs leading-relaxed"
                            dangerouslySetInnerHTML={{
                                __html: DOMPurify.sanitize(previewData.description || ""),
                            }}
                        />
                    </div>
                </div>
            )}
        </section>
    );
}
