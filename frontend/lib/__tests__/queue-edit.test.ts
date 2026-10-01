import { describe, expect, it } from "vitest";
import { insertTrack, removeTrack } from "../queue-edit";

const snap = (queue: string[], currentIndex: number, shuffleIndices: number[] = [], isShuffle = false) => ({
    queue,
    currentIndex,
    shuffleIndices,
    isShuffle,
});

describe("insertTrack", () => {
    it("inserts at the up-next cursor and advances it", () => {
        const first = insertTrack(snap(["a", "b", "c"], 0), { upNextAt: 1, shufflePos: 0 }, "x");
        expect(first.queue).toEqual(["a", "x", "b", "c"]);
        expect(first.upNextAt).toBe(2);

        const second = insertTrack(snap(first.queue, 0), { upNextAt: first.upNextAt, shufflePos: 0 }, "y");
        expect(second.queue).toEqual(["a", "x", "y", "b", "c"]);
    });

    it("clamps a cursor past the end", () => {
        expect(insertTrack(snap(["a"], 0), { upNextAt: 9, shufflePos: 0 }, "x").queue).toEqual(["a", "x"]);
    });

    it("plays the new track next in shuffle order", () => {
        const next = insertTrack(snap(["a", "b", "c"], 0, [2, 0, 1], true), { upNextAt: 1, shufflePos: 0 }, "x");
        expect(next.queue).toEqual(["a", "x", "b", "c"]);
        expect(next.shuffleIndices).toEqual([3, 0, 1, 2]);
        expect(next.shufflePos).toBe(3);
    });

    it("leaves shuffle order alone when shuffle is off", () => {
        expect(insertTrack(snap(["a"], 0, [0]), { upNextAt: 1, shufflePos: 0 }, "x").shuffleIndices).toEqual([0]);
    });

    it("does not change its input", () => {
        const input = snap(["a", "b"], 0, [1, 0], true);
        insertTrack(input, { upNextAt: 1, shufflePos: 0 }, "x");
        expect(input).toEqual(snap(["a", "b"], 0, [1, 0], true));
    });
});

describe("removeTrack", () => {
    it("shifts the current index when an earlier track goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 2), 0);
        expect(next.queue).toEqual(["b", "c"]);
        expect(next.currentIndex).toBe(1);
        expect(next.currentTrack).toBeUndefined();
    });

    it("keeps the current track when a later one goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 0), 2);
        expect(next.currentIndex).toBe(0);
        expect(next.currentTrack).toBeUndefined();
    });

    it("moves to the following track when the current one goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 1), 1);
        expect(next.currentIndex).toBe(1);
        expect(next.currentTrack).toBe("c");
    });

    it("wraps to the start when the last track was current", () => {
        const next = removeTrack(snap(["a", "b"], 1), 1);
        expect(next.currentIndex).toBe(0);
        expect(next.currentTrack).toBe("a");
    });

    it("clears the track when the queue empties", () => {
        expect(removeTrack(snap(["a"], 0), 0).currentTrack).toBeNull();
    });

    it("renumbers shuffle order", () => {
        expect(removeTrack(snap(["a", "b", "c"], 0, [2, 0, 1], true), 1).shuffleIndices).toEqual([1, 0]);
    });
});
