/**
 * The one way Kima connects to Lidarr. Every request is counted and timed, with
 * ids in the path folded so each album does not become its own metric series.
 */

import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { lidarrApiCallsTotal, lidarrApiDuration } from "../utils/metrics";

export function createLidarrClient(baseURL: string, apiKey: string, timeout = 30_000): AxiosInstance {
    const client = axios.create({
        baseURL: baseURL.replace(/\/+$/, ""),
        timeout,
        headers: { "X-Api-Key": apiKey },
    });
    const started = new WeakMap<object, number>();
    const record = (config: InternalAxiosRequestConfig | undefined, status: "success" | "failed") => {
        if (!config) return;
        const endpoint = (config.url ?? "").split("?")[0].replace(/\/\d+(?=\/|$)/g, "/:id");
        lidarrApiCallsTotal.inc({ endpoint, status });
        const start = started.get(config);
        if (start !== undefined) lidarrApiDuration.observe({ endpoint }, (Date.now() - start) / 1000);
    };
    client.interceptors.request.use((config) => {
        started.set(config, Date.now());
        return config;
    });
    client.interceptors.response.use(
        (response) => {
            record(response.config, "success");
            return response;
        },
        (error) => {
            record(error.config, "failed");
            return Promise.reject(error);
        }
    );
    return client;
}
