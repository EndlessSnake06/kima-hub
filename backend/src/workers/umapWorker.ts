import { parentPort, workerData } from "worker_threads";
import { UMAP } from "umap-js";

const { embeddings, nNeighbors } = workerData as {
    embeddings: number[][];
    nNeighbors: number;
};

try {
    const umap = new UMAP({
        nComponents: 3,
        nNeighbors,
        minDist: 0.1,
        spread: 1.0,
    });

    const projection = umap.fit(embeddings);
    parentPort?.postMessage(projection);
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ error: message });
    process.exit(1);
}
