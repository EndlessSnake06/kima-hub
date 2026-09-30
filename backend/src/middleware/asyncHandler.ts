/**
 * Route a rejected async handler to `errorHandler`. Express 4 discards the
 * promise, so a throw becomes an unhandled rejection and the request is never
 * answered. A thrown AppError gets its category's status; anything else a 500.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction
) => unknown;

export function asyncHandler(handler: AsyncRouteHandler): RequestHandler {
    return (req, res, next) => {
        // `Promise.resolve` rather than assuming the handler is async: a
        // synchronous handler passed through here still works, and a
        // synchronous THROW still propagates the way Express already handles
        // it. Wrapping is never wrong, so nobody has to decide.
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
