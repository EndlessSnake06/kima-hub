import { parentPort, workerData } from "worker_threads";

// Loader hooks do not apply in worker threads, so the module is named with
// the extension the running shape actually has on disk: .js when compiled,
// .ts when Node's own type support is running this file.
const layoutModule = typeof __filename === "string" ? "../services/mapLayout.js" : "../services/mapLayout.ts";

const { embeddings, k } = workerData as { embeddings: number[][]; k: number };

(async () => {
    try {
        const { computeLayout } = (await import(layoutModule)) as typeof import("../services/mapLayout");
        parentPort?.postMessage(computeLayout(embeddings, { k }));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        parentPort?.postMessage({ error: message });
        process.exit(1);
    }
})();
