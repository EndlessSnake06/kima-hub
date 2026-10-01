"use client";

import Link from "next/link";
import { SimilarArtist } from "../types";
import { Music, Library } from "lucide-react";
import { plural } from "@/lib/format";
import { api } from "@/lib/api";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { CachedImage } from "@/components/ui/CachedImage";

interface SimilarArtistsProps {
    similarArtists: SimilarArtist[];
}

export function SimilarArtists({ similarArtists }: SimilarArtistsProps) {
    if (!similarArtists || similarArtists.length === 0) {
        return null;
    }

    return (
        <section>
            <SectionHeader type="artist" title="Fans Also Like" />
            <div
                data-tv-section="similar-artists"
                className="grid-media"
            >
                {similarArtists.map((artist, index) => {
                    const rawImage = artist.coverArt || artist.image;
                    const imageUrl = rawImage
                        ? api.getCoverArtUrl(rawImage, 300)
                        : null;
                    const matchPercentage = artist.weight
                        ? Math.round(artist.weight * 100)
                        : null;

                    const navigationId = artist.inLibrary
                        ? artist.id
                        : artist.mbid || artist.id;

                    return (
                        <Link
                            key={artist.id || artist.name}
                            href={`/artist/${navigationId}`}
                            data-tv-card
                            data-tv-card-index={index}
                            className="block bg-transparent hover:bg-white/5 transition-colors p-3 rounded-md group"
                        >
                            <div className="w-full aspect-square bg-[#282828] rounded-full mb-2.5 overflow-hidden relative">
                                {imageUrl ? (
                                    <CachedImage
                                        src={imageUrl}
                                        alt={artist.name}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                        className="object-cover group-hover:scale-105 transition-transform"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Music className="w-12 h-12 text-[var(--text-muted)]" />
                                    </div>
                                )}
                                {artist.inLibrary && (
                                    <div
                                        className="absolute bottom-1 right-1 bg-brand rounded-full p-1"
                                        title="In your library"
                                    >
                                        <Library className="w-3 h-3 text-black" />
                                    </div>
                                )}
                            </div>

                            <h3 className="text-sm font-semibold text-white truncate mb-0.5">
                                {artist.name}
                            </h3>

                            <p className="text-xs text-[var(--text-secondary)] truncate">
                                {artist.ownedAlbumCount && artist.ownedAlbumCount > 0
                                    ? `${plural(artist.ownedAlbumCount, "album")} in library`
                                    : "Artist"}
                            </p>

                            {matchPercentage !== null && (
                                <p className="text-xs text-brand mt-1">
                                    {matchPercentage}% match
                                </p>
                            )}
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
