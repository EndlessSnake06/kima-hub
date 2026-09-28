/**
 * One timeout contract for the whole backend: reject with a labeled
 * Error when the promise outlives the budget. Callers that want to
 * swallow a timeout catch it explicitly — silently resolving to
 * `undefined` (the old second contract) let callers keep going on a
 * value that never arrived.
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
