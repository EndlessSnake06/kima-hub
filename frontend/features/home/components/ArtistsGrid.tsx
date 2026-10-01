"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo, type CSSProperties } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { cascadeStyle } from "@/lib/motion";
import { cn } from "@/lib/cn";
import type { Artist, PopularArtist } from "../types";

interface ArtistTile {
    key: string;
    name: string;
    href: string;
    coverArt?: string;
    subtitle: string;
}

interface ArtistTileCardProps extends Omit<ArtistTile, "key"> {
    index: number;
}

const ArtistTileCard = memo(function ArtistTileCard({
    name,
    href,
    coverArt,
    subtitle,
    index,
}: ArtistTileCardProps) {
    const imageSrc = coverArt ? api.getCoverArtUrl(coverArt, 300) : null;

    return (
        <CarouselItem>
            <Link
                href={href}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "group block",
                    "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                )}
                style={{ "--i": index } as CSSProperties}
            >
                <div className="relative bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden hover:border-type-artist/40 transition-[border-color] duration-150 mx-1">
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                            {imageSrc ? (
                                <Image
                                    src={imageSrc}
                                    alt={name}
                                    fill
                                    sizes="180px"
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    unoptimized
                                />
                            ) : (
                                <Music className="w-10 h-10 text-[var(--text-muted)]" />
                            )}
                        </div>
                    </div>
                    <div className="h-0.5 bg-type-artist scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    <div className="relative z-10 p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-bold text-white truncate tracking-tight">
                            {name}
                        </h3>
                        <p className="text-xs tabular-nums text-[var(--text-muted)] mt-0.5">
                            {subtitle}
                        </p>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

function ArtistTileGrid({ tiles }: { tiles: ArtistTile[] }) {
    return (
        <HorizontalCarousel style={cascadeStyle(tiles.length)}>
            {tiles.map(({ key, ...tile }, index) => (
                <ArtistTileCard key={key} {...tile} index={index} />
            ))}
        </HorizontalCarousel>
    );
}

export const ArtistsGrid = memo(function ArtistsGrid({ artists }: { artists: Artist[] }) {
    return (
        <ArtistTileGrid
            tiles={artists.map((a) => ({
                key: a.id,
                name: a.name,
                href: `/artist/${a.id}`,
                coverArt: a.coverArt,
                subtitle: "Artist",
            }))}
        />
    );
});

// Popular artists come from outside the library, so they open a search rather than an artist page.
export const PopularArtistsGrid = memo(function PopularArtistsGrid({
    artists,
}: {
    artists: PopularArtist[];
}) {
    return (
        <ArtistTileGrid
            tiles={artists.map((a) => ({
                key: a.id || a.name,
                name: a.name,
                href: `/search?q=${encodeURIComponent(a.name)}`,
                coverArt: a.image,
                subtitle: `${a.listeners?.toLocaleString()} listeners`,
            }))}
        />
    );
});
