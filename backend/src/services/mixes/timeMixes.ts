import { ProgrammaticMix, sampledMix } from "./helpers";
import { NOT_MISSING } from "../../utils/libraryEligibility";

const TRACK_LIMIT = 20;

export async function generateDayMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    const today = new Date().toISOString().split("T")[0];

    switch (dayOfWeek) {
        case 0:
            return generateSundayMix(userId, today);
        case 1:
            return generateMondayMix(userId, today);
        case 5:
            return generateFridayMix(userId, today);
        default:
            return null;
    }
}

async function generateSundayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `sunday-${today}`,
        type: "sunday-morning",
        name: "Sunday Morning",
        description: "Peaceful tunes for a lazy Sunday",
        colorType: "sunday-morning",
        take: 100,
        minTracks: 15,
        limit: TRACK_LIMIT,
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            energy: { lte: 0.5 },
            acousticness: { gte: 0.5 },
        },
    });
}

async function generateMondayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `monday-${today}`,
        type: "confidence-boost",
        name: "Monday Motivation",
        description: "Start your week with energy",
        colorType: "confidence-boost",
        take: 100,
        minTracks: 15,
        limit: TRACK_LIMIT,
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            energy: { gte: 0.6 },
            valence: { gte: 0.5 },
        },
    });
}

async function generateFridayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `friday-${today}`,
        type: "dance-floor",
        name: "Friday Night",
        description: "Weekend vibes to kick off the party",
        colorType: "dance-floor",
        take: 100,
        minTracks: 15,
        limit: TRACK_LIMIT,
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            danceability: { gte: 0.7 },
            energy: { gte: 0.6 },
        },
    });
}
