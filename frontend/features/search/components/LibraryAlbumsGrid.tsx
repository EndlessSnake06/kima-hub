import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import { MediaCard } from "@/components/cards/MediaCard";
import { Album } from "../types";

interface LibraryAlbumsGridProps {
    albums: Album[];
}

export function LibraryAlbumsGrid({ albums }: LibraryAlbumsGridProps) {
    return (
        <div className="grid-media" data-tv-section="search-results-albums">
            {albums.slice(0, 6).map((album, index) => (
                <MediaCard
                    key={album.id}
                    href={`/album/${album.id}`}
                    title={album.title}
                    subtitle={album.artist?.name || ""}
                    imageUrl={
                        album.coverUrl || album.albumId
                            ? api.getCoverArtUrl((album.coverUrl || album.albumId)!, 200)
                            : null
                    }
                    fallbackIcon={Disc3}
                    type="album"
                    index={index}
                />
            ))}
        </div>
    );
}
