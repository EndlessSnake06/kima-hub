"use client";

import { Book, ArrowLeft } from "lucide-react";
import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Audiobook } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";
import { CachedImage } from "@/components/ui/CachedImage";

interface AudiobookHeroProps {
    audiobook: Audiobook;
    heroImage: string | null;
    colors: ColorPalette | null;
    formatTime: (seconds: number) => string;
    children?: ReactNode;
}

function truncateDescription(description: string, maxLen: number): string {
    const clean = description.replace(/<[^>]*>/g, "").trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).trimEnd() + "...";
}

export function AudiobookHero({
    audiobook,
    heroImage,
    colors,
    formatTime,
    children,
}: AudiobookHeroProps) {
    const router = useRouter();
    const progressPercent = audiobook.progress?.progress || 0;
    const isFinished = audiobook.progress?.isFinished;

    return (
        <div className="relative">
            <HeroBackdrop
                image={heroImage}
                alt={audiobook.title}
                colors={colors}
                tint="spoken"
                fallback={["#2a1e0a", "#1a140a"]}
            />

            <div className="relative page-shell pt-8 pb-6">
                <div>
                    <button
                        onClick={() => router.push("/audiobooks")}
                        className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Audiobooks
                    </button>

                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-type-audiobook rounded-full" />
                        <span className="t-eyebrow">
                            Audiobook
                        </span>
                    </div>

                    <div className="flex items-end gap-6">
                        {/* Cover Art - Square for audiobooks */}
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden relative border-2 border-white/10">
                            {heroImage ? (
                                <CachedImage
                                    src={heroImage}
                                    alt={audiobook.title}
                                    fill
                                    sizes="(max-width: 768px) 140px, 192px"
                                    className="object-cover"
                                    priority
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Book className="w-16 h-16 text-white/10" />
                                </div>
                            )}
                        </div>

                        <div className="flex-1 min-w-0 pb-1">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                                {audiobook.title}
                            </h1>

                            {audiobook.description && (
                                <p className="text-sm text-[var(--text-muted)] line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                    {truncateDescription(audiobook.description, 200)}
                                </p>
                            )}

                            <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                                <span className="font-bold text-white tracking-tight text-sm">
                                    {audiobook.author}
                                </span>
                                {audiobook.narrator && (
                                    <>
                                        <span className="text-[var(--text-muted)]">|</span>
                                        <span>{audiobook.narrator}</span>
                                    </>
                                )}
                                <span className="text-[var(--text-muted)]">|</span>
                                <span>{formatTime(audiobook.duration)}</span>
                                <span className="text-[var(--text-muted)]">|</span>
                                <span className={isFinished ? "text-success" : "text-brand"}>
                                    {isFinished ? "Finished" : `${Math.round(progressPercent)}% complete`}
                                </span>
                            </div>

                            {(audiobook.series || (audiobook.genres && audiobook.genres.length > 0)) && (
                                <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                                    {audiobook.series && (
                                        <span className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-xs tabular-nums text-brand">
                                            {audiobook.series.name} #{audiobook.series.sequence}
                                        </span>
                                    )}
                                    {audiobook.genres?.slice(0, 3).map((genre: string) => (
                                        <span
                                            key={genre}
                                            className="px-2.5 py-0.5 bg-white/5 border border-white/10 rounded text-xs tabular-nums text-[var(--text-secondary)]"
                                        >
                                            {genre}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {children && (
                <div className="relative page-shell pb-4">
                    <div>
                        {children}
                    </div>
                </div>
            )}
        </div>
    );
}
