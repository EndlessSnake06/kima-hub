import { NextRequest } from "next/server";
import { backendUrl } from "@/lib/backend-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy for SSE ticket issuance.
 *
 * The Next.js rewrite pattern excludes /api/events/* from proxying
 * (to allow the SSE streaming route handler). This route forwards
 * ticket requests to the backend manually.
 */
export async function POST(request: NextRequest) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
        return new Response("Unauthorized", { status: 401 });
    }

    let backendResponse: Response;
    try {
        backendResponse = await fetch(`${backendUrl}/api/events/ticket`, {
            method: "POST",
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json",
            },
        });
    } catch {
        return new Response("Backend unavailable", { status: 502 });
    }

    const body = await backendResponse.text();
    return new Response(body, {
        status: backendResponse.status,
        headers: { "Content-Type": "application/json" },
    });
}
