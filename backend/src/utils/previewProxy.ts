import axios from "axios";
import type { Response } from "express";
import { logger } from "./logger";
import { upstreamHeader } from "./upstreamHeaders";

/**
 * Pipe a Deezer preview to the client as same-origin media. An upstream 404
 * answers 404 with `notFoundMessage`; any other failure is thrown to the caller.
 */
export async function proxyPreviewStream(
    res: Response,
    previewUrl: string,
    { notFoundMessage, logLabel }: { notFoundMessage: string; logLabel: string }
): Promise<void> {
    let upstream;
    try {
        upstream = await axios.get(previewUrl, {
            responseType: "stream",
            timeout: 10000,
        });
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            res.status(404).json({ error: notFoundMessage });
            return;
        }
        throw error;
    }

    const upstreamContentLength = upstreamHeader(upstream.headers["content-length"]);
    const upstreamAcceptRanges = upstreamHeader(upstream.headers["accept-ranges"]);

    res.setHeader(
        "Content-Type",
        upstreamHeader(upstream.headers["content-type"]) || "audio/mpeg"
    );
    if (upstreamContentLength) {
        res.setHeader("Content-Length", upstreamContentLength);
    }
    if (upstreamAcceptRanges) {
        res.setHeader("Accept-Ranges", upstreamAcceptRanges);
    }
    res.setHeader("Cache-Control", "no-store");

    upstream.data.on("error", (streamErr: unknown) => {
        logger.error(`${logLabel} pipe error:`, streamErr);
        if (!res.headersSent) {
            res.status(502).end();
        } else {
            res.end();
        }
    });

    // Clean up upstream stream when client disconnects (preview cancelled, tab closed, etc)
    res.on("close", () => {
        if (!upstream.data.destroyed) {
            upstream.data.destroy();
        }
    });

    upstream.data.pipe(res);
}
