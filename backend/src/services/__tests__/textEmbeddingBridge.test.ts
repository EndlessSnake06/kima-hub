/**
 * Tests for the textEmbeddingBridge DOOR: searchTracksByText's full path from
 * a plain query string to the pgvector ranking query. textSearch.test.ts
 * covers the ranking half in isolation; these pin the wiring the door adds:
 * the Redis pub/sub round trip to the analyzer, the failure and timeout
 * handling (the bridge must ride out a dead analyzer and recover), and that
 * the embedding reaches the transaction's $queryRaw in pgvector's text form
 * with the LIMIT (S1: the query must run inside the ef_search-widened
 * transaction, on tx, never the pool).
 *
 * Redis and prisma are mocked at their boundaries; the real pub/sub flow in
 * textEmbeddingBridge.ts (shared subscriber + publisher, listener keyed by
 * requestId) runs for real.
 */

const duplicateMock = jest.fn();
jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: {
        duplicate: (...a: unknown[]) => duplicateMock(...a),
    },
}));

const queryRawMock = jest.fn();
const txQueryRawMock = jest.fn();
const transactionMock = jest.fn();
jest.mock("../../utils/db", () => ({
    __esModule: true,
    prisma: {
        $queryRaw: (...a: unknown[]) => queryRawMock(...a),
        // S1: the ranking query must run inside the ef_search-widened
        // transaction, on the transaction's own client (a pool-level call
        // would land on a connection without the raised width). The stub
        // $transaction invokes the callback with a tx whose $queryRaw lands
        // on txQueryRawMock, so the assertions below can tell a
        // transaction-scoped call from a pool-level one.
        $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
            transactionMock(fn);
            return fn({ $queryRaw: (...a: unknown[]) => txQueryRawMock(...a) });
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { searchTracksByText, TextSearchRow } from "../textEmbeddingBridge";

const RESPONSE_PREFIX = "audio:text:embed:response:";

const ROW_A: TextSearchRow = {
    id: "t1",
    title: "First",
    duration: 200,
    trackNo: 1,
    distance: 0.3,
    albumId: "a1",
    albumTitle: "Al",
    albumCoverUrl: null,
    artistId: "ar1",
    artistName: "Ar",
};
// Worse distance than ROW_A and past any plausible threshold: the bridge must
// return ranked rows as pgvector ordered them, with NO similarity cut-off.
const ROW_B: TextSearchRow = { ...ROW_A, id: "t2", title: "Second", distance: 0.9 };

// The bridge's pmessage handler, captured when the shared subscriber wires up.
let onPMessage: ((pattern: string, channel: string, message: string) => void) | undefined;
let lastRequest: { requestId: string; text: string } | undefined;

function makeConn() {
    const conn: any = {
        status: "ready",
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (event === "pmessage") onPMessage = handler as typeof onPMessage;
            return conn;
        }),
        publish: jest.fn(async (_channel: string, message: string) => {
            lastRequest = JSON.parse(message);
            return 1;
        }),
        psubscribe: jest.fn(async () => undefined),
        disconnect: jest.fn(),
    };
    return conn;
}

function deliverResponse(request: { requestId: string }, payload: unknown) {
    onPMessage?.("audio:text:embed*", `${RESPONSE_PREFIX}${request.requestId}`, JSON.stringify(payload));
}

// Flush pending microtasks (the bridge awaits between subscribe and publish).
async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
    duplicateMock.mockReset().mockImplementation(() => makeConn());
    queryRawMock.mockReset();
    txQueryRawMock.mockReset();
    transactionMock.mockReset();
    lastRequest = undefined;
});

describe("searchTracksByText", () => {
    it("round-trips the query into the pgvector ranking query and returns its rows in order", async () => {
        txQueryRawMock.mockResolvedValue([ROW_A, ROW_B]);

        const pending = searchTracksByText("solo piano", 25);
        await flush();
        expect(lastRequest).toBeDefined();
        expect(lastRequest!.text).toBe("solo piano");
        deliverResponse(lastRequest!, { success: true, embedding: [0.1, 0.2, -0.3] });

        const rows = await pending;
        // Soft duplicate options: the shared client is strict/fail-fast, but
        // pub/sub must ride out a cold Redis (#197).
        expect(duplicateMock).toHaveBeenCalledWith({
            enableOfflineQueue: true,
            maxRetriesPerRequest: null,
        });
        // S1: the ranking query runs inside the ef_search-widened transaction
        // on the transaction's own client -- never on the pool, where the
        // raised width would not be in effect.
        expect(transactionMock).toHaveBeenCalledTimes(1);
        expect(queryRawMock).not.toHaveBeenCalled();
        expect(txQueryRawMock).toHaveBeenCalledTimes(2);
        // First tx call: the transaction-local ef_search raise, sized from the
        // requested limit (efFor(25, 0) floors at 100). The is_local=true flag
        // is literal SQL text in the template, so it is asserted there.
        const [configStrings, efValue] = txQueryRawMock.mock.calls[0];
        const configSql = configStrings.join(" ");
        expect(configSql).toContain("set_config('hnsw.ef_search'");
        expect(configSql).toContain(", true)");
        expect(efValue).toBe("100");
        // Ranking is pgvector's ORDER BY on the cosine distance of the SAME
        // interpolated vector used for the selected distance column.
        const [strings, vectorForSelect, vectorForOrder, limitArg] = txQueryRawMock.mock.calls[1];
        expect(strings.join(" ")).toContain("ORDER BY te.embedding <=>");
        expect(vectorForSelect).toBe("[0.1,0.2,-0.3]");
        expect(vectorForOrder).toBe("[0.1,0.2,-0.3]");
        expect(limitArg).toBe(25);
        // Ranked list passes through untouched -- no re-sort, no cut-off, so
        // the weaker match stays in the results behind the better one.
        expect(rows).toEqual([ROW_A, ROW_B]);
    });

    it("rejects and never reaches pgvector when the analyzer reports failure", async () => {
        const pending = searchTracksByText("synth pop", 10);
        await flush();
        deliverResponse(lastRequest!, { success: false, embedding: null });

        await expect(pending).rejects.toThrow("Analyzer failed to produce embedding");
        expect(txQueryRawMock).not.toHaveBeenCalled();
    });

    it("rejects on timeout, ignores the late reply, and lets the next request succeed", async () => {
        jest.useFakeTimers();
        try {
            const pending = searchTracksByText("quiet piano", 10);
            await flush();
            const deadRequest = lastRequest;

            const timedOut = expect(pending).rejects.toThrow("Text embedding request timed out");
            await jest.advanceTimersByTimeAsync(15_001);
            await timedOut;

            // The analyzer's answer arrives after the listener was torn down:
            // it must be dropped, not delivered to the wrong request.
            deliverResponse(deadRequest!, { success: true, embedding: [1, 1, 1] });

            txQueryRawMock.mockResolvedValue([ROW_A]);
            const second = searchTracksByText("loud piano", 5);
            await flush();
            expect(lastRequest!.text).toBe("loud piano");
            deliverResponse(lastRequest!, { success: true, embedding: [0.4, 0.5, 0.6] });

            await expect(second).resolves.toEqual([ROW_A]);
        } finally {
            jest.useRealTimers();
        }
    });
});
