import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { shuffleArray } from "../../utils/shuffle";

export interface ProgrammaticMix {
    id: string;
    type: string;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
}

// Research-based color psychology for mix vibes
// Using actual CSS rgba values for inline styles (Tailwind classes get purged at build time)
const MIX_COLORS: Record<string, string> = {
    // Night/Introspection - Deep blues and purples for calm, night sky, solitude
    "late-night":
        "linear-gradient(to bottom, rgba(30, 27, 75, 0.7), rgba(30, 58, 138, 0.5), rgba(15, 23, 42, 0.4))",
    "3am-thoughts":
        "linear-gradient(to bottom, rgba(46, 16, 101, 0.7), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "night-drive":
        "linear-gradient(to bottom, rgba(15, 23, 42, 0.7), rgba(49, 46, 129, 0.5), rgba(88, 28, 135, 0.4))",

    // Calm/Relaxation - Teal and seafoam for spa-like tranquility
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    "coffee-shop":
        "linear-gradient(to bottom, rgba(120, 53, 15, 0.6), rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4))",
    "rainy-day":
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(31, 41, 55, 0.5), rgba(39, 39, 42, 0.4))",
    "sunday-morning":
        "linear-gradient(to bottom, rgba(253, 186, 116, 0.4), rgba(252, 211, 77, 0.3), rgba(68, 64, 60, 0.4))",

    // Energy/Workout - Red and orange to increase heart rate
    workout:
        "linear-gradient(to bottom, rgba(153, 27, 27, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    "confidence-boost":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(68, 64, 60, 0.4))",

    // Happy/Uplifting - Yellow and warm amber for optimism
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    "summer-vibes":
        "linear-gradient(to bottom, rgba(8, 145, 178, 0.5), rgba(15, 118, 110, 0.4), rgba(30, 58, 138, 0.4))",
    "golden-hour":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(234, 88, 12, 0.4), rgba(136, 19, 55, 0.4))",

    // Sad/Melancholy - Cool blue-grays for "feeling blue"
    melancholy:
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(30, 58, 138, 0.5), rgba(17, 24, 39, 0.4))",
    "sad-girl-sundays":
        "linear-gradient(to bottom, rgba(136, 19, 55, 0.5), rgba(30, 41, 59, 0.5), rgba(59, 7, 100, 0.4))",
    "heartbreak-hotel":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",

    // Party/Dance - Hot pink and magenta for club energy
    "dance-floor":
        "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",

    // Acoustic/Organic - Warm browns like wood instruments
    acoustic:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    unplugged:
        "linear-gradient(to bottom, rgba(68, 64, 60, 0.6), rgba(120, 53, 15, 0.5), rgba(38, 38, 38, 0.4))",

    // Focus/Instrumental - Purple for creativity and concentration
    instrumental:
        "linear-gradient(to bottom, rgba(91, 33, 182, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "focus-flow":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(30, 41, 59, 0.5), rgba(17, 24, 39, 0.4))",

    // Adventure/Road Trip - Sunset oranges for freedom
    "road-trip":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(14, 165, 233, 0.4))",

    // Character/Mood Archetypes
    "main-character":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(202, 138, 4, 0.4), rgba(124, 45, 18, 0.4))",
    "villain-era":
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",

    // Nostalgia - Sepia and vintage tones
    throwback:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.5), rgba(124, 45, 18, 0.4), rgba(68, 64, 60, 0.4))",

    // Genre/Era based - More neutral but themed
    era: "linear-gradient(to bottom, rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4), rgba(39, 39, 42, 0.4))",
    genre: "linear-gradient(to bottom, rgba(63, 63, 70, 0.5), rgba(30, 41, 59, 0.4), rgba(17, 24, 39, 0.4))",
    "top-tracks":
        "linear-gradient(to bottom, rgba(6, 95, 70, 0.5), rgba(17, 94, 89, 0.4), rgba(15, 23, 42, 0.4))",
    rediscover:
        "linear-gradient(to bottom, rgba(55, 48, 163, 0.5), rgba(76, 29, 149, 0.4), rgba(15, 23, 42, 0.4))",
    "artist-similar":
        "linear-gradient(to bottom, rgba(107, 33, 168, 0.5), rgba(112, 26, 117, 0.4), rgba(15, 23, 42, 0.4))",
    discovery:
        "linear-gradient(to bottom, rgba(2, 132, 199, 0.5), rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.4))",

    // Mood-on-demand default
    mood: "linear-gradient(to bottom, rgba(162, 28, 175, 0.5), rgba(107, 33, 168, 0.4), rgba(15, 23, 42, 0.4))",

    // Default fallback
    default:
        "linear-gradient(to bottom, rgba(88, 28, 135, 0.4), rgba(26, 26, 26, 1), transparent)",
};

export function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

export function randomSample<T>(array: T[], count: number): T[] {
    return shuffleArray(array).slice(0, count);
}

/** Up to four album covers, in track order, for a mix's cover mosaic. */
export function albumCoverUrls(
    tracks: { album: { coverUrl: string | null } }[]
): string[] {
    return tracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);
}

export function getSeededRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}


/**
 * Deterministic Fisher-Yates shuffle using getSeededRandom's LCG; unbiased,
 * unlike sorting with a random comparator.
 */
export function seededShuffle<T>(array: T[], seed: number): T[] {
    const result = [...array];
    let random = seed;
    for (let i = result.length - 1; i > 0; i--) {
        random = (random * 9301 + 49297) % 233280;
        const j = Math.floor((random / 233280) * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

export type TrackWithAlbumCover = {
    id: string;
    album: {
        coverUrl: string | null;
        genres?: unknown;
        userGenres?: string[] | null;
        artist?: {
            userGenres?: string[] | null;
        };
    };
    essentiaGenres?: string[];
    [key: string]: unknown;
};

interface MixSpec {
    id: string;
    type: string;
    name: string;
    description: string;
    /** Key into the mix colour table. */
    colorType: string;
}

/** A mix of `limit` randomly sampled tracks. */
export function sampleMix(
    spec: MixSpec,
    tracks: { id: string; album: { coverUrl: string | null } }[],
    limit: number
): ProgrammaticMix {
    const sample = randomSample(tracks, limit);

    return {
        id: spec.id,
        type: spec.type,
        name: spec.name,
        description: spec.description,
        trackIds: sample.map((t) => t.id),
        coverUrls: albumCoverUrls(sample),
        trackCount: sample.length,
        color: getMixColor(spec.colorType),
    };
}

/** A sampled mix of the tracks that match a filter, or null when too few do. */
export async function sampledMix(
    spec: MixSpec & {
        where: Prisma.TrackWhereInput;
        /** How many matching tracks to fetch before sampling. */
        take: number;
        /** Fewest fetched tracks that still make a mix. */
        minTracks: number;
        /** Tracks in the finished mix. */
        limit: number;
    }
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: spec.where,
        include: { album: { select: { coverUrl: true } } },
        take: spec.take,
    });

    if (tracks.length < spec.minTracks) return null;

    return sampleMix(spec, tracks, spec.limit);
}

const WITH_ALBUM_GENRES = {
    album: {
        select: {
            coverUrl: true,
            genres: true,
            userGenres: true,
            artist: { select: { userGenres: true } },
        },
    },
} satisfies Prisma.TrackInclude;

/**
 * Tracks matching genre patterns: the Genre/TrackGenre tables first, then
 * album.genres and user genres in memory for tracks the tables lack.
 */
export async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100
): Promise<TrackWithAlbumCover[]> {
    const genreRows = await prisma.genre.findMany({
        where: {
            name: { in: genrePatterns, mode: "insensitive" },
        },
        select: { id: true },
    });

    const tracks =
        genreRows.length === 0
            ? []
            : await prisma.track.findMany({
                  where: {
                      ...NOT_MISSING,
                      trackGenres: {
                          some: {
                              genreId: { in: genreRows.map((g) => g.id) },
                          },
                      },
                  },
                  include: WITH_ALBUM_GENRES,
                  take: limit,
              });

    if (tracks.length >= 15) {
        return tracks as TrackWithAlbumCover[];
    }

    const albumTracks = await prisma.track.findMany({
        where: {
            ...NOT_MISSING,
            album: {
                OR: [
                    { genres: { not: { equals: null } } },
                    { userGenres: { not: { equals: null } } },
                ],
            },
        },
        include: WITH_ALBUM_GENRES,
        take: limit * 3,
    });

    const genreMatched = albumTracks.filter((t) => {
        const albumGenres = t.album.genres as string[] | null;
        const albumUserGenres = (t.album.userGenres as string[] | null) || [];
        const artistUserGenres =
            (t.album.artist?.userGenres as string[] | null) || [];

        const allGenres = [
            ...(albumGenres || []),
            ...albumUserGenres,
            ...artistUserGenres,
        ];

        if (allGenres.length === 0) return false;

        return allGenres.some((ag) =>
            genrePatterns.some((gp) =>
                ag.toLowerCase().includes(gp.toLowerCase())
            )
        );
    });

    const existingIds = new Set(tracks.map((t) => t.id));
    const merged = [
        ...tracks,
        ...genreMatched.filter((t) => !existingIds.has(t.id)),
    ];

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}
