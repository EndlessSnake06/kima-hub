"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
    GenreCount,
    DecadeCount,
    STATIC_STATIONS,
    buildGenreStations,
    buildDecadeStations,
    useRadioPlayer,
} from "@/features/home/radioData";
import type { RadioStation } from "@/features/home/radioData";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHeader } from "@/components/layout/PageHeader";

function RadioStationCard({
    station,
    loadingStation,
    onPlay,
}: {
    station: RadioStation;
    loadingStation: string | null;
    onPlay: () => void;
}) {
    return (
        <button
            onClick={onPlay}
            disabled={loadingStation !== null}
            className={cn(
                "relative group w-full overflow-hidden",
                "aspect-[4/3] rounded-lg",
                "bg-[var(--bg-primary)] border-2 border-white/10",
                station.hoverBorder,
                "transition-all duration-300",
                station.hoverShadow,
                "hover:scale-[1.02] active:scale-[0.98]",
                "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
        >
            <div className={cn("absolute inset-0 bg-gradient-to-br", station.color)} />

            <div className="absolute inset-0 p-4 flex flex-col justify-end">
                <div>
                    <h3 className="text-base font-bold text-white truncate tracking-tight leading-tight mb-1">
                        {station.name}
                    </h3>
                    <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            <div className={cn(
                "absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r",
                station.accentGradient,
                "transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center"
            )} />

            {loadingStation === station.id && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-(--z-raised)">
                    <Loader2 className="w-6 h-6 text-white animate-spin" />
                </div>
            )}

            {loadingStation !== station.id && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-12 h-12 rounded-lg bg-white flex items-center justify-center">
                        <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
                    </div>
                </div>
            )}
        </button>
    );
}

function SectionSkeleton() {
    return (
        <div className="grid-media">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] rounded-lg bg-[var(--bg-primary)] border-2 border-white/10 animate-pulse" />
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
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        loadingStation={loadingStation}
                                        onPlay={() => startRadio(station)}
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
                                        <button
                                            onClick={() => refetchGenres()}
                                            aria-label="Retry loading genre stations"
                                            className="min-h-[44px] px-4 py-2 text-sm border border-[var(--color-brand)] text-[var(--color-brand)] rounded hover:bg-[var(--color-brand)]/10 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                ) : (
                                    <div className="grid-media">
                                        {genreStations.map((station) => (
                                            <RadioStationCard
                                                key={station.id}
                                                station={station}
                                                loadingStation={loadingStation}
                                                onPlay={() => startRadio(station)}
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
                                        <button
                                            onClick={() => refetchDecades()}
                                            aria-label="Retry loading decade stations"
                                            className="min-h-[44px] px-4 py-2 text-sm border border-[var(--color-brand)] text-[var(--color-brand)] rounded hover:bg-[var(--color-brand)]/10 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                ) : (
                                    <div className="grid-media">
                                        {decadeStations.map((station) => (
                                            <RadioStationCard
                                                key={station.id}
                                                station={station}
                                                loadingStation={loadingStation}
                                                onPlay={() => startRadio(station)}
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
