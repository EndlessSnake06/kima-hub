"use client";

import { Disc3 } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { Album, AlbumSource } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useAlbumDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatDuration } from "@/lib/format";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";

// Lazy load MetadataEditor - modal component opened on user action
const MetadataEditor = lazy(() => import("@/components/MetadataEditor").then(mod => ({ default: mod.MetadataEditor })));

interface AlbumHeroProps {
    album: Album;
    source: AlbumSource;
    coverUrl: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

export function AlbumHero({
    album,
    source,
    coverUrl,
    colors,
    onReload,
    children,
}: AlbumHeroProps) {
    const displayData = useAlbumDisplayData(album);

    const totalDuration = album.duration ? formatDuration(album.duration) : "";

    return (
        <div className="relative animate-rise">
            <HeroBackdrop
                image={coverUrl}
                alt={album.title}
                colors={colors}
                tint="music"
                fallback={["#3d2a1e", "#1a1a1a"]}
            />

            {/* Compact Hero Content - Full Width */}
            <div className="relative px-4 md:px-8 pt-16 pb-6">
                <div className="flex items-end gap-6">
                    {/* Album Cover - Square */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shrink-0 overflow-hidden relative">
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={album.title}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Disc3 className="w-16 h-16 text-[var(--text-muted)]" />
                            </div>
                        )}
                    </div>

                    {/* Album Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <div className="w-1.5 h-1.5 bg-brand rounded-full" />
                            <span className="t-eyebrow">Album</span>
                        </div>
                        <div className="flex items-center gap-2 group mb-2">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-tight line-clamp-2">
                                {displayData.title}
                            </h1>
                            {displayData.hasUserOverrides && (
                                <span className="px-2 py-0.5 text-xs bg-brand/20 text-brand rounded-full border border-brand/30 shrink-0">
                                    Edited
                                </span>
                            )}
                            {source === "library" && (
                                <Suspense fallback={null}>
                                    <MetadataEditor
                                        type="album"
                                        id={album.id}
                                        currentData={{
                                            title: displayData.title,
                                            year: displayData.year ?? undefined,
                                            genres: displayData.genres,
                                            mbid: album.mbid,
                                            coverUrl: displayData.coverUrl ?? undefined,
                                            // Pass originals for reset comparison
                                            _originalTitle: album.title,
                                            _originalYear: album.year,
                                            _originalGenres: album.genre ? [album.genre] : [],
                                            _originalCoverUrl: album.coverUrl,
                                            _hasUserOverrides: displayData.hasUserOverrides,
                                        }}
                                        onSave={async () => {
                                            await onReload();
                                        }}
                                    />
                                </Suspense>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-sm text-[var(--text-secondary)] mb-1">
                            {album.artist && (
                                <Link
                                    href={`/artist/${album.artist.id}`}
                                    className="font-medium text-white hover:underline"
                                >
                                    {album.artist.name}
                                </Link>
                            )}
                            {displayData.year && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{displayData.year}</span>
                                </>
                            )}
                            {album.trackCount && album.trackCount > 0 && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{album.trackCount} songs</span>
                                </>
                            )}
                            {totalDuration && <span>, {totalDuration}</span>}
                        </div>
                        {album.genre && (
                            <span className="inline-block px-2 py-0.5 bg-white/10 rounded-full text-xs text-[var(--text-secondary)]">
                                {album.genre}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Action Bar - Full Width */}
            {children && (
                <div className="relative px-4 md:px-8 pb-4">{children}</div>
            )}
        </div>
    );
}
