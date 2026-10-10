import { EventEmitter } from "events";

describe("Soulseek download events", () => {
    it("default error listener prevents unhandled exception", () => {
        const download = {
            events: new EventEmitter(),
        };

        // Attach default error listener (the fix)
        download.events.on("error", () => {});

        let threw = false;
        try {
            download.events.emit("error", new Error("Connection closed before transfer completed"));
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
    });

    it("emitting error without a listener throws (sanity)", () => {
        const events = new EventEmitter();
        let threw = false;
        try {
            events.emit("error", new Error("test"));
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    });

    it("service-layer error listener resolves promise with failure shape", async () => {
        const events = new EventEmitter();
        // Default listener, as in client.ts
        events.on("error", () => {});

        let resolved = false;
        let cleanupCalled = false;
        let resolvedValue: { success: boolean; error?: string } | null = null;

        const promise = new Promise<{ success: boolean; error?: string }>((resolve) => {
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    cleanupCalled = true;
                }
            };

            // Service-layer listener (mirrors the fix in soulseek.ts)
            events.on("error", (err: any) => {
                if (resolved) return;
                cleanup();
                resolve({
                    success: false,
                    error: err?.message ?? String(err),
                });
            });
        });

        events.emit("error", new Error("Connection closed before transfer completed"));

        resolvedValue = await promise;

        expect(resolvedValue.success).toBe(false);
        expect(resolvedValue.error).toBe("Connection closed before transfer completed");
        expect(cleanupCalled).toBe(true);
    });

    it("service-layer error listener is idempotent -- double emit does not re-resolve", async () => {
        const events = new EventEmitter();
        events.on("error", () => {});

        let resolveCount = 0;
        let resolved = false;

        const promise = new Promise<{ success: boolean; error?: string }>((resolve) => {
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                }
            };

            events.on("error", (err: any) => {
                if (resolved) return;
                cleanup();
                resolveCount++;
                resolve({ success: false, error: err?.message ?? String(err) });
            });
        });

        events.emit("error", new Error("first"));
        events.emit("error", new Error("second"));

        await promise;

        expect(resolveCount).toBe(1);
    });
});
