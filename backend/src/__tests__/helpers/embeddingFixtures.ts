import { prisma } from "../../utils/db";
import { MATCHING_MODEL } from "../../services/matching/state";

/** A unit 512-dim vector with cosine `cos` to axis 0; no ties, so rankings are exact. */
export function unitVectorAt(cos: number, axis: number): string {
    const v = Array(512).fill(0);
    v[0] = cos;
    v[axis] = Math.sqrt(1 - cos * cos);
    return `[${v.join(",")}]`;
}

export async function seedEmbedding(trackId: string, vector: string) {
    // Mirrors services/audio-analyzer-clap/analyzer.py's insert shape
    // (%s::vector). Prisma cannot write Unsupported("vector") columns.
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        vector,
        MATCHING_MODEL,
    );
}
