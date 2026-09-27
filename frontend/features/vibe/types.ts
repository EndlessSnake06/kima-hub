export interface MapTrack {
    id: string;
    x: number;
    y: number;
    /** Third layout axis. Absent on maps computed before the 3D layout; treated as the middle. */
    z?: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

export interface PathTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

export interface PathResult {
    startTrack: PathTrack;
    endTrack: PathTrack;
    path: PathTrack[];
    metadata: {
        totalTracks: number;
        embeddingDistance: number;
        averageStepSize: number;
        mode: string;
    };
}

export interface TrackResult {
    id: string;
    title: string;
    duration?: number;
    similarity?: number;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

export type VibeMode = "idle" | "similar" | "search" | "path-picking" | "path-result" | "alchemy";
