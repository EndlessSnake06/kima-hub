import { Book } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { Audiobook } from "../types";
import { api } from "@/lib/api";

interface LibraryAudiobooksGridProps {
    audiobooks: Audiobook[];
}

export function LibraryAudiobooksGrid({
    audiobooks,
}: LibraryAudiobooksGridProps) {
    return (
        <div
            className="grid-media"
            data-tv-section="search-results-audiobooks"
        >
            {audiobooks.slice(0, 6).map((audiobook, index) => (
                <MediaCard
                    key={audiobook.id}
                    href={`/audiobooks/${audiobook.id}`}
                    title={audiobook.title}
                    subtitle={audiobook.author || "Unknown author"}
                    imageUrl={
                        audiobook.coverUrl
                            ? api.getCoverArtUrl(audiobook.coverUrl, 200)
                            : null
                    }
                    fallbackIcon={Book}
                    accentColor={{
                        border: "hover:border-type-audiobook/50",
                        gradient: "bg-type-audiobook",
                        button: "bg-brand text-black",
                        shadow: "",
                    }}
                    index={index}
                />
            ))}
        </div>
    );
}
