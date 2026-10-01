"use client";

import { Music2 } from "lucide-react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { cascadeStyle } from "@/lib/motion";
import { memo } from "react";
import { PlaylistPreview } from "../types";
import { MediaCard } from "@/components/cards/MediaCard";
import { plural } from "@/lib/format";

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

export function FeaturedPlaylistsSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden animate-fade-soft">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px]">
                    <div className="bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden mx-1">
                        <div className="aspect-square bg-[#181818] animate-pulse" />
                        <div className="p-3">
                            <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                            <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

export const FeaturedPlaylistsGrid = memo(function FeaturedPlaylistsGrid({
    playlists,
}: FeaturedPlaylistsGridProps) {
    if (!playlists || playlists.length === 0) {
        return null;
    }

    return (
        <HorizontalCarousel style={cascadeStyle(Math.min(playlists.length, 20))}>
            {playlists.slice(0, 20).map((playlist, index) => (
                <CarouselItem key={`home-playlist-${playlist.id}-${index}`}>
                    <MediaCard
                        href={`/browse/playlists/${playlist.id}`}
                        title={playlist.title}
                        subtitle={plural(playlist.trackCount, "track")}
                        imageUrl={playlist.imageUrl || null}
                        fallbackIcon={Music2}
                        type="track"
                        index={index}
                        sizes="180px"
                        className="mx-1"
                        badge={
                            <span className="block p-1 bg-black/60 rounded">
                                <DeezerIcon className="w-3.5 h-3.5 text-brand" />
                            </span>
                        }
                    />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
});
