/**
 * Runs an exported function of a module in this folder in a worker thread. The worker loads the module by path:
 * compiled, it is plain JavaScript; run from source, the worker registers tsx itself, because a worker thread does
 * not inherit the parent's TypeScript loader.
 */
import { Worker } from "worker_threads";

export function runInWorker<T>(modulePath: string, exportName: string, args: unknown[]): Promise<T> {
    const loader = modulePath.endsWith(".ts") ? `require(${JSON.stringify(require.resolve("tsx/cjs"))});` : "";
    const code = `${loader}
        const { parentPort, workerData } = require("worker_threads");
        const run = require(${JSON.stringify(modulePath)})[${JSON.stringify(exportName)}];
        Promise.resolve(run(...workerData)).then((result) => parentPort.postMessage(result));`;
    return new Promise((resolve, reject) => {
        const worker = new Worker(code, { eval: true, workerData: args });
        worker.once("message", (result: T) => resolve(result));
        worker.once("error", reject);
        worker.once("exit", (exitCode) => {
            if (exitCode !== 0) reject(new Error(`${exportName} worker exited with code ${exitCode}`));
        });
    });
}
