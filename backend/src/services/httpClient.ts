/** A GET through the global rate limiter, for enrichment integrations. */

import axios, { AxiosRequestConfig } from "axios";
import { rateLimiter, ServiceName } from "./rateLimiter";

/**
 * Perform a rate-limited GET request, resolving to the response body.
 *
 * @param service - the rate-limiter service key (see SERVICE_CONFIGS in rateLimiter.ts)
 * @param url - the request URL
 * @param config - optional axios request config (headers, params, etc.)
 */
export async function rateLimitedGet<T = any>(
    service: ServiceName,
    url: string,
    config?: AxiosRequestConfig
): Promise<T> {
    return rateLimiter.execute(service, async () => {
        const res = await axios.get<T>(url, config);
        return res.data;
    });
}
