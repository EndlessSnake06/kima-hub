"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { TileCard } from "@/components/cards/TileCard";
import {
    GenreCount,
    DecadeCount,
    STATIC_STATIONS,
    buildGenreStations,
    buildDecadeStations,
    useRadioPlayer,
} from "@/features/home/radioData";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/layout/PageHeader";

function SectionSkeleton() {
    return (
        <div className="grid-media">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
            ))}
        </div>
    );
}

export default function RadioPage() {
    const { loadingStation, startRadio } = useRadioPlayer();

    const { data: genresData, isLoading: genresLoading, isError: genresError, refetch: refetchGenres } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: 5 * 60 * 1000,
        select: (data) => (data.genres || []).filter((g) => g.count >= 15),
    });

    const { data: decadesData, isLoading: decadesLoading, isError: decadesError, refetch: refetchDecades } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: 5 * 60 * 1000,
        select: (data) => data.decades || [],
    });

    const isLoading = genresLoading || decadesLoading;

    const genreStations = useMemo(() => buildGenreStations(genresData ?? []), [genresData]);
    const decadeStations = useMemo(() => buildDecadeStations(decadesData ?? []), [decadesData]);

    return (
        <div className="min-h-screen">
            <div className="relative">
                <PageHeader
                    eyebrow="Your library"
                    title="Radio"
                    description={
                        isLoading
                            ? "Endless shuffles from your own music"
                            : `${STATIC_STATIONS.length + genreStations.length + decadeStations.length} stations, each an endless shuffle from your own music`
                    }
                />

                <div className="relative page-shell pb-32 pt-2 animate-rise">
                    <div className="section-stack">
                        <section>
                            <SectionHeader title="Quick Start" />
                            <div className="grid-media">
                                {STATIC_STATIONS.map((station) => (
                                    <TileCard
                                        key={station.id}
                                        title={station.name}
                                        subtitle={station.description}
                                        tint={station.color}
                                        hoverBorder={station.hoverBorder}
                                        accent={station.accentGradient}
                                        onClick={() => startRadio(station)}
                                        playable
                                        busy={loadingStation === station.id}
                                        disabled={loadingStation !== null}
                                        className="w-full aspect-[4/3]"
                                    />
                                ))}
                            </div>
                        </section>

                        {(isLoading || genresError || genreStations.length > 0) && (
                            <section>
                                <SectionHeader
                                    type="track"
                                    title="By Genre"
                                    count={!isLoading && !genresError ? `${genreStations.length} genres` : undefined}
                                />
                                {isLoading ? (
                                    <SectionSkeleton />
                                ) : genresError ? (
                                    <div className="flex items-center gap-3 py-4">
                                        <p className="text-sm text-[var(--text-secondary)]">
                                            Could not load genre stations.
                                        </p>
                                        <Button
                                            onClick={() => refetchGenres()}
                                            aria-label="Retry loading genre stations"
                                        >
                                            Retry
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="grid-media">
                                        {genreStations.map((station) => (
                                            <TileCard
                                                key={station.id}
                                                title={station.name}
                                                subtitle={station.description}
                                                tint={station.color}
                                                hoverBorder={station.hoverBorder}
                                                accent={station.accentGradient}
                                                onClick={() => startRadio(station)}
                                                playable
                                                busy={loadingStation === station.id}
                                                disabled={loadingStation !== null}
                                                className="w-full aspect-[4/3]"
                                            />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {(isLoading || decadesError || decadeStations.length > 0) && (
                            <section>
                                <SectionHeader
                                    type="track"
                                    title="By Decade"
                                    count={!isLoading && !decadesError ? `${decadeStations.length} decades` : undefined}
                                />
                                {isLoading ? (
                                    <SectionSkeleton />
                                ) : decadesError ? (
                                    <div className="flex items-center gap-3 py-4">
                                        <p className="text-sm text-[var(--text-secondary)]">
                                            Could not load decade stations.
                                        </p>
                                        <Button
                                            onClick={() => refetchDecades()}
                                            aria-label="Retry loading decade stations"
                                        >
                                            Retry
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="grid-media">
                                        {decadeStations.map((station) => (
                                            <TileCard
                                                key={station.id}
                                                title={station.name}
                                                subtitle={station.description}
                                                tint={station.color}
                                                hoverBorder={station.hoverBorder}
                                                accent={station.accentGradient}
                                                onClick={() => startRadio(station)}
                                                playable
                                                busy={loadingStation === station.id}
                                                disabled={loadingStation !== null}
                                                className="w-full aspect-[4/3]"
                                            />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        <p className="t-meta">
                            Genre and decade stations appear once your library has enough tracks for them.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
