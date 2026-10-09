/** A number array as pgvector's text form, which casts to `vector` whatever the values are. */
export function formatEmbedding(values: ArrayLike<number>): string {
    return `[${Array.from(values).join(",")}]`;
}

/**
 * Parse a pgvector embedding from its text form "[0.1,0.2,...]" to the single-precision values pgvector stores,
 * whatever rounding the text used.
 */
export function parseEmbedding(text: string): number[] {
    if (!text || typeof text !== "string") {
        throw new Error("Invalid embedding: expected non-empty string");
    }
    const values = text.replace(/[\[\]]/g, "").split(",").map((v) => Math.fround(Number(v)));
    if (values.some(v => !Number.isFinite(v))) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }
    return values;
}
