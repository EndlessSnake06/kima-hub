"use client";

import { Mic2, ArrowLeft } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ColorPalette } from "@/hooks/useImageColor";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";

interface PodcastHeroProps {
    title: string;
    author: string;
    description?: string;
    genres?: string[];
    heroImage: string | null;
    colors: ColorPalette | null;
    episodeCount: number;
    inProgressCount: number;
    children?: ReactNode;
}

function truncateDescription(description: string, maxLen: number): string {
    const clean = description.replace(/<[^>]*>/g, "").trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).trimEnd() + "...";
}

export function PodcastHero({
    title,
    author,
    description,
    genres,
    heroImage,
    colors,
    episodeCount,
    inProgressCount,
    children,
}: PodcastHeroProps) {
    const router = useRouter();

    return (
        <div className="relative">
            <HeroBackdrop
                image={heroImage}
                alt={title}
                colors={colors}
                tint="spoken"
                fallback={["#0f1a2e", "#0a0f1a"]}
            />

            {/* Hero Content */}
            <div className="relative page-shell pt-8 pb-6">
                <div>
                    {/* Back navigation */}
                    <button
                        onClick={() => router.push("/podcasts")}
                        className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                    >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        Podcasts
                    </button>

                    {/* System status */}
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-[var(--color-brand)] rounded-full" />
                        <span className="t-eyebrow">
                            Podcast
                        </span>
                    </div>

                    <div className="flex items-end gap-6">
                        {/* Cover Art - Square with border treatment */}
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden relative border-2 border-white/10">
                            {heroImage ? (
                                <Image
                                    src={heroImage}
                                    alt={title}
                                    fill
                                    sizes="(max-width: 768px) 140px, 192px"
                                    className="object-cover"
                                    priority
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Mic2 className="w-16 h-16 text-[var(--text-muted)]" />
                                </div>
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 pb-1">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                                {title}
                            </h1>

                            {description && (
                                <p className="text-sm text-[var(--text-muted)] line-clamp-2 max-w-3xl mb-3 hidden md:block">
                                    {truncateDescription(description, 200)}
                                </p>
                            )}

                            {/* Metadata row */}
                            <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                                <span className="font-bold text-white normal-case tracking-tight text-sm">
                                    {author}
                                </span>
                                <span className="text-[var(--text-muted)]">|</span>
                                <span>
                                    {episodeCount} {episodeCount === 1 ? "episode" : "episodes"}
                                </span>
                                {inProgressCount > 0 && (
                                    <>
                                        <span className="text-[var(--text-muted)]">|</span>
                                        <span className="text-[var(--color-brand)]">
                                            {inProgressCount} in progress
                                        </span>
                                    </>
                                )}
                            </div>

                            {/* Genre tags */}
                            {genres && genres.length > 0 && (
                                <div className="hidden md:flex flex-wrap gap-1.5 mt-3">
                                    {genres.slice(0, 4).map((genre: string) => (
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

            {/* Action Bar */}
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
