"use client";

import { Disc } from "lucide-react";
import { Podcast } from "../types";
import { memo } from "react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { cascadeStyle } from "@/lib/motion";
import { MediaCard } from "@/components/cards/MediaCard";

interface PodcastsGridProps {
    podcasts: Podcast[];
}

const getProxiedImageUrl = (podcast: Podcast): string | null => {
    const imageUrl = podcast.coverUrl || podcast.coverArt || podcast.imageUrl;
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

const PodcastsGrid = memo(function PodcastsGrid({
    podcasts,
}: PodcastsGridProps) {
    return (
        <HorizontalCarousel style={cascadeStyle(podcasts.length)}>
            {podcasts.map((podcast, index) => (
                <CarouselItem key={podcast.id}>
                    <MediaCard
                        href={`/podcasts/${podcast.id}`}
                        title={podcast.title}
                        subtitle={podcast.author || "Podcast"}
                        imageUrl={getProxiedImageUrl(podcast)}
                        fallbackIcon={Disc}
                        type="podcast"
                        index={index}
                        sizes="180px"
                        className="mx-1"
                    />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
});

export { PodcastsGrid };
