"use client";

import { Music } from "lucide-react";
import { Artist, ArtistSource, Album } from "../types";
import { ReactNode } from "react";
import { MetadataEditControls } from "@/components/MetadataEditControls";
import { useArtistDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { HeroBackdrop } from "@/components/ui/HeroBackdrop";
import { CachedImage } from "@/components/ui/CachedImage";
import { plural } from "@/lib/format";

interface ArtistHeroProps {
    artist: Artist;
    source: ArtistSource | null;
    albums: Album[];
    heroImage: string | null;
    backgroundImage?: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

export function ArtistHero({
    artist,
    source,
    albums,
    heroImage,
    backgroundImage,
    colors,
    onReload,
    children,
}: ArtistHeroProps) {
    const displayData = useArtistDisplayData(artist);
    const ownedAlbums = albums.filter((a) => a.owned);

    // Use background image if provided, otherwise fall back to hero image
    const bgImage = backgroundImage || heroImage;

    return (
        <div className="relative animate-rise">
            <HeroBackdrop
                image={bgImage}
                alt={displayData.name}
                colors={colors}
                tint="music"
                fallback={["#3d2a1e", "#1a1a1a"]}
            />

            <div className="relative page-shell pt-16 pb-6">
                <div className="flex items-end gap-6">
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded-full shrink-0 overflow-hidden relative">
                        {heroImage ? (
                            <CachedImage
                                src={heroImage}
                                alt={displayData.name}
                                fill
                                sizes="(max-width: 768px) 140px, 192px"
                                className="object-cover"
                                priority
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-16 h-16 text-[var(--text-muted)]" />
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            <div className="w-1.5 h-1.5 bg-type-artist rounded-full" />
                            <span className="t-eyebrow">Artist</span>
                        </div>
                        <div className="flex items-center gap-3 group mb-2">
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-tight line-clamp-2">
                                {displayData.name}
                            </h1>
                            <MetadataEditControls
                                edited={displayData.hasUserOverrides}
                                editable={source === "library"}
                                type="artist"
                                id={artist.id}
                                currentData={{
                                    name: displayData.name,
                                    bio: displayData.summary ?? undefined,
                                    genres: displayData.genres,
                                    mbid: artist.mbid,
                                    heroUrl: displayData.heroUrl ?? undefined,
                                    _originalName: artist.name,
                                    _originalBio:
                                        artist.summary ?? artist.bio,
                                    _originalGenres:
                                        artist.genres ?? artist.tags ?? [],
                                    _originalHeroUrl:
                                        artist.heroUrl ?? artist.image,
                                    _hasUserOverrides:
                                        displayData.hasUserOverrides,
                                }}
                                onSave={async () => {
                                    await onReload();
                                }}
                            />
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-sm text-[var(--text-secondary)]">
                            {artist.listeners && artist.listeners > 0 && (
                                <>
                                    <span>
                                        {artist.listeners.toLocaleString()}{" "}
                                        listeners
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            {albums.length > 0 && (
                                <>
                                    <span>{plural(albums.length, "album")}</span>
                                    {ownedAlbums.length > 0 && (
                                        <>
                                            <span className="mx-1">•</span>
                                            <span className="text-brand">
                                                {ownedAlbums.length} owned
                                            </span>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {children && (
                <div className="relative page-shell pb-4">{children}</div>
            )}
        </div>
    );
}
