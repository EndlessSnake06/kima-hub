"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Radio, ChevronLeft, ChevronRight } from "lucide-react";
import { TileCard } from "@/components/cards/TileCard";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { cascadeStyle } from "@/lib/motion";
import { useLibraryGenresQuery, useLibraryDecadesQuery } from "@/hooks/useQueries";
import {
    RadioStation,
    STATIC_STATIONS,
    buildGenreStations,
    buildDecadeStations,
    useRadioPlayer,
} from "../radioData";

export function LibraryRadioStations() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const { data: genresData, isLoading: genresLoading } = useLibraryGenresQuery();
    const { data: decadesData, isLoading: decadesLoading } = useLibraryDecadesQuery();

    const isLoading = genresLoading || decadesLoading;
    const genres = useMemo(
        () => (genresData?.genres || []).filter((g) => g.count >= 15).slice(0, 6),
        [genresData],
    );
    const decades = useMemo(
        () => (decadesData?.decades || []).slice(0, 4),
        [decadesData],
    );

    const allStations = useMemo(() => {
        return [
            ...STATIC_STATIONS,
            ...buildGenreStations(genres),
            ...buildDecadeStations(decades),
        ];
    }, [genres, decades]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const stationPages = useMemo(() => {
        const pages: RadioStation[][] = [];
        for (let i = 0; i < allStations.length; i += 6) {
            pages.push(allStations.slice(i, i + 6));
        }
        return pages;
    }, [allStations]);

    const checkScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
        if (isMobileOrTablet) {
            const pageWidth = el.clientWidth;
            setCurrentPage(Math.round(el.scrollLeft / pageWidth));
        }
    }, [isMobileOrTablet]);

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) el.removeEventListener("scroll", checkScroll);
            window.removeEventListener("resize", checkScroll);
        };
    }, [stationPages, isMobileOrTablet, checkScroll]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollBy({
            left: direction === "left" ? -(el.clientWidth * 0.8) : el.clientWidth * 0.8,
            behavior: "smooth",
        });
    };

    const renderCard = (station: RadioStation, compact: boolean, globalIdx: number, delayIdx = globalIdx) => (
        <TileCard
            key={station.id}
            title={station.name}
            subtitle={station.description}
            eyebrow={
                <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <Radio className="w-3 h-3" />
                    Radio
                </span>
            }
            tint={station.color}
            hoverBorder={station.hoverBorder}
            accent={station.accentGradient}
            onClick={() => startRadio(station)}
            playable
            busy={loadingStation === station.id}
            disabled={loadingStation !== null}
            index={delayIdx}
            className={compact ? "flex-shrink-0 snap-start w-[180px] h-[80px]" : "w-full aspect-[5/3]"}
        />
    );

    // Desktop: horizontal scroll
    if (!isMobileOrTablet) {
        return (
            <div className="relative group/carousel">
                {canScrollLeft && (
                    <button
                        onClick={() => scroll("left")}
                        className="absolute left-0 top-1/2 -translate-y-1/2 z-(--z-raised) w-9 h-9 rounded-lg bg-black/80 flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black border border-white/10 -translate-x-1/2"
                        aria-label="Scroll left"
                    >
                        <ChevronLeft className="w-5 h-5 text-white" />
                    </button>
                )}

                <div
                    ref={scrollRef}
                    className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3 px-1"
                    style={cascadeStyle(allStations.length)}
                >
                    {allStations.map((station, i) => renderCard(station, true, i))}
                    {isLoading &&
                        Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="flex-shrink-0 w-[180px] h-[80px] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
                        ))}
                </div>

                {canScrollRight && (
                    <button
                        onClick={() => scroll("right")}
                        className="absolute right-0 top-1/2 -translate-y-1/2 z-(--z-raised) w-9 h-9 rounded-lg bg-black/80 flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black border border-white/10 translate-x-1/2"
                        aria-label="Scroll right"
                    >
                        <ChevronRight className="w-5 h-5 text-white" />
                    </button>
                )}
            </div>
        );
    }

    // Mobile: 2x3 grid pages
    return (
        <div className="relative">
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3"
            >
                {stationPages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-2"
                        style={cascadeStyle(page.length)}
                    >
                        {page.map((station, i) => renderCard(station, false, pageIndex * 6 + i, i))}
                        {page.length < 6 &&
                            Array.from({ length: 6 - page.length }).map((_, i) => (
                                <div key={`empty-${i}`} className="aspect-[5/3]" />
                            ))}
                    </div>
                ))}
                {isLoading && (
                    <div className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="aspect-[5/3] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
                        ))}
                    </div>
                )}
            </div>

            {stationPages.length > 1 && (
                <div className="flex justify-center mt-1">
                    {stationPages.map((_, index) => (
                        <button
                            key={index}
                            onClick={() => {
                                const el = scrollRef.current;
                                if (el) el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
                            }}
                            className="group/dot flex items-center justify-center"
                            aria-label={`Go to page ${index + 1}`}
                            aria-current={index === currentPage ? "true" : undefined}
                        >
                            <span
                                className={cn(
                                    "w-1.5 h-1.5 rounded-full transition-colors",
                                    index === currentPage ? "bg-white" : "bg-white/30 group-hover/dot:bg-white/50",
                                )}
                            />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
