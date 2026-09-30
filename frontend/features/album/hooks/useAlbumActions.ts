import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-context";
import { useDownloadContext } from "@/lib/download-context";
import { shuffleArray } from "@/utils/shuffle";
import { useToast } from "@/lib/toast-context";
import { Album, Track } from "../types";

const toQueueTrack = (track: Track, album: Album) => ({
    id: track.id,
    title: track.title,
    duration: track.duration,
    artist: {
        name: track.artist?.name || album.artist?.name || "",
        id: track.artist?.id || album.artist?.id || "",
    },
    album: {
        title: album.title,
        id: album.id,
        coverArt: album.coverArt || album.coverUrl,
    },
});

export function useAlbumActions() {
    const { toast } = useToast();
    const {
        playTracks,
        playTrack: playTrackAudio,
        addToQueue: addToQueueAudio,
    } = useAudioControls();
    const { addPendingDownload, isPendingByMbid } = useDownloadContext();

    const requireAlbum = (album: Album | null): album is Album => {
        if (!album) toast.error("Album data not available");
        return !!album;
    };

    const playAlbum = (album: Album | null, startIndex: number = 0) => {
        if (!requireAlbum(album) || !album.tracks) return;
        playTracks(album.tracks.map((t) => toQueueTrack(t, album)), startIndex);
    };

    const shufflePlay = (album: Album | null) => {
        if (!requireAlbum(album) || !album.tracks) return;
        playTracks(shuffleArray(album.tracks.map((t) => toQueueTrack(t, album))), 0);
    };

    const playTrack = (track: Track, album: Album | null) => {
        if (!requireAlbum(album)) return;
        playTrackAudio(toQueueTrack(track, album));
    };

    const addToQueue = (track: Track, album: Album | null) => {
        if (!requireAlbum(album)) return;
        addToQueueAudio(toQueueTrack(track, album));
        toast.success(`Added "${track.title}" to queue`);
    };

    const downloadAlbum = async (album: Album | null, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
        }

        if (!requireAlbum(album)) return;

        const mbid = album.rgMbid || album.mbid || album.id;
        if (!mbid) {
            toast.error("Album MBID not available");
            return;
        }

        if (isPendingByMbid(mbid)) {
            toast.info("Album is already being downloaded");
            return;
        }

        try {
            addPendingDownload("album", album.title, mbid);

            toast.info(`Preparing download: "${album.title}"...`);

            await api.downloadAlbum(
                album.artist?.name || "Unknown Artist",
                album.title,
                mbid
            );

            toast.success(`Downloading "${album.title}"`);
        } catch {
            toast.error("Failed to start album download");
        }
    };

    return {
        playAlbum,
        shufflePlay,
        playTrack,
        addToQueue,
        downloadAlbum,
    };
}
