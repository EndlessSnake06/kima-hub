/**
 * `asyncHandler` passes a rejected route handler's error to `next()`. Without
 * it, Express 4 sends no response at all; that case is not tested here because
 * Jest fails any unhandled rejection.
 */

import express from "express";
import request from "supertest";
import { asyncHandler } from "../asyncHandler";

/** Stands in for the real errorHandler; same shape, no config dependency. */
function errorSink(
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
) {
    res.status(500).json({ reachedErrorHandler: true, message: err.message });
}

describe("asyncHandler bridges the rejection to next()", () => {
    it("reaches the error handler when the handler throws", async () => {
        const app = express();
        app.get(
            "/wrapped",
            asyncHandler(async () => {
                throw new Error("boom");
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/wrapped");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ reachedErrorHandler: true, message: "boom" });
    });

    it("reaches the error handler when the handler rejects rather than throws", async () => {
        const app = express();
        app.get(
            "/rejects",
            asyncHandler(() => Promise.reject(new Error("rejected")))
        );
        app.use(errorSink);

        const res = await request(app).get("/rejects");

        expect(res.body).toEqual({ reachedErrorHandler: true, message: "rejected" });
    });

    it("leaves a successful handler completely alone", async () => {
        const app = express();
        app.get(
            "/ok",
            asyncHandler(async (_req, res) => {
                res.status(201).json({ fine: true });
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/ok");

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ fine: true });
    });

    it("handles a SYNCHRONOUS handler, including one that throws", async () => {
        // Wrapping must never be the wrong choice, so that nobody has to decide
        // per-route whether a handler is async enough to need it.
        const app = express();
        app.get(
            "/sync-throws",
            asyncHandler(() => {
                throw new Error("sync boom");
            })
        );
        app.use(errorSink);

        const res = await request(app).get("/sync-throws");

        expect(res.body).toEqual({ reachedErrorHandler: true, message: "sync boom" });
    });

    it("does not swallow next() called by the handler itself", async () => {
        const app = express();
        app.get(
            "/passes-through",
            asyncHandler(async (_req, _res, next) => {
                next();
            }),
            (_req, res) => res.json({ secondHandlerRan: true })
        );
        app.use(errorSink);

        const res = await request(app).get("/passes-through");

        expect(res.body).toEqual({ secondHandlerRan: true });
    });
});
