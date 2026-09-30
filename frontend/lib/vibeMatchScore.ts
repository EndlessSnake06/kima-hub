import type { AudioFeatures } from "@/lib/audio-state-context";

const MATCH_FEATURES = [
    { key: "energy", min: 0, max: 1 },
    { key: "valence", min: 0, max: 1 },
    { key: "arousal", min: 0, max: 1 },
    { key: "danceability", min: 0, max: 1 },
    { key: "bpm", min: 60, max: 200 },
    { key: "moodHappy", min: 0, max: 1 },
    { key: "moodSad", min: 0, max: 1 },
    { key: "moodRelaxed", min: 0, max: 1 },
    { key: "moodAggressive", min: 0, max: 1 },
    { key: "moodParty", min: 0, max: 1 },
    { key: "moodAcoustic", min: 0, max: 1 },
    { key: "moodElectronic", min: 0, max: 1 },
] as const;

function normalize(value: number | null | undefined, min: number, max: number): number {
    if (value == null) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function computeVibeMatchScore(
    source: AudioFeatures | null | undefined,
    current: AudioFeatures | null | undefined,
): number | null {
    if (!source || !current) return null;

    const sourceVector: number[] = [];
    const currentVector: number[] = [];

    for (const feature of MATCH_FEATURES) {
        const sVal = (source as Record<string, unknown>)[feature.key];
        const cVal = (current as Record<string, unknown>)[feature.key];
        const sNorm = normalize(
            typeof sVal === "number" ? sVal : null,
            feature.min,
            feature.max,
        );
        const cNorm = normalize(
            typeof cVal === "number" ? cVal : null,
            feature.min,
            feature.max,
        );
        const weight = feature.key.startsWith("mood") ? 1.3 : 1.0;
        sourceVector.push(sNorm * weight);
        currentVector.push(cNorm * weight);
    }

    let dotProduct = 0;
    let magSource = 0;
    let magCurrent = 0;

    for (let i = 0; i < sourceVector.length; i++) {
        dotProduct += sourceVector[i] * currentVector[i];
        magSource += sourceVector[i] * sourceVector[i];
        magCurrent += currentVector[i] * currentVector[i];
    }

    const magnitude = Math.sqrt(magSource) * Math.sqrt(magCurrent);
    if (magnitude === 0) return null;

    return Math.round((dotProduct / magnitude) * 100);
}
