export interface QueueSnapshot<T> {
    queue: T[];
    shuffleIndices: number[];
    isShuffle: boolean;
    currentIndex: number;
}

export interface InsertCursors {
    upNextAt: number;
    shufflePos: number;
}

const clamp = (n: number, max: number) => Math.min(Math.max(0, n), max);

export function insertTrack<T>(snap: QueueSnapshot<T>, cursors: InsertCursors, track: T) {
    const insertAt = clamp(cursors.upNextAt, snap.queue.length);
    const queue = [...snap.queue];
    queue.splice(insertAt, 0, track);

    let shuffleIndices = snap.shuffleIndices;
    let shufflePos = cursors.shufflePos;
    if (snap.isShuffle && shuffleIndices.length > 0) {
        const shifted = shuffleIndices.map((i) => (i >= insertAt ? i + 1 : i));
        const playingPos = shifted.indexOf(snap.currentIndex);
        const insertPos = clamp(Math.max(playingPos + 1, shufflePos), shifted.length);
        shifted.splice(insertPos, 0, insertAt);
        shuffleIndices = shifted;
        shufflePos = insertPos + 1;
    }

    return { queue, shuffleIndices, upNextAt: insertAt + 1, shufflePos };
}

export function removeTrack<T>(snap: QueueSnapshot<T>, index: number) {
    const queue = [...snap.queue];
    queue.splice(index, 1);

    const shuffleIndices = snap.isShuffle
        ? snap.shuffleIndices.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i))
        : snap.shuffleIndices;

    let currentIndex = snap.currentIndex;
    let currentTrack: T | null | undefined;
    if (index < currentIndex) {
        currentIndex -= 1;
    } else if (index === currentIndex) {
        if (queue.length === 0) {
            currentTrack = null;
        } else if (index >= queue.length) {
            currentIndex = 0;
            currentTrack = queue[0];
        } else {
            currentTrack = queue[index];
        }
    }

    return { queue, shuffleIndices, currentIndex, currentTrack };
}
