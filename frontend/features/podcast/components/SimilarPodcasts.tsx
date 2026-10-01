"use client";

import { Mic2 } from "lucide-react";
import { SimilarPodcast } from "../types";
import { api } from "@/lib/api";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { SectionHeader } from "@/components/ui/SectionHeader";

interface SimilarPodcastsProps {
    podcasts: SimilarPodcast[];
}

export function SimilarPodcasts({ podcasts }: SimilarPodcastsProps) {
    if (!podcasts || podcasts.length === 0) {
        return null;
    }

    return (
        <section>
            <SectionHeader title="Fans Also Like" type="podcast" />
            <div data-tv-section="similar-podcasts" className="grid-media">
                {podcasts.map((podcast, index) => (
                    <PlayableCard
                        key={podcast.id}
                        href={`/podcasts/${podcast.id}`}
                        coverArt={podcast.coverUrl ? api.getCoverArtUrl(podcast.coverUrl, 300) : null}
                        title={podcast.title}
                        subtitle={podcast.author}
                        placeholderIcon={<Mic2 className="w-12 h-12 text-[var(--text-muted)]" />}
                        circular={false}
                        showPlayButton={false}
                        tvCardIndex={index}
                    />
                ))}
            </div>
        </section>
    );
}
