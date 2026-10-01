/**
 * Every Lidarr request is counted and timed by the shared client, with ids in
 * the path folded so each album does not become its own metric series.
 */

import { createLidarrClient } from "../lidarrClient";
import { lidarrApiCallsTotal, lidarrApiDuration } from "../../utils/metrics";

const client = createLidarrClient("http://lidarr.test", "key");
client.defaults.adapter = async (config: any) => {
    if (config.url.includes("/missing/")) {
        throw Object.assign(new Error("Not found"), { config, response: { status: 404 }, isAxiosError: true });
    }
    return { data: {}, status: 200, statusText: "OK", headers: {}, config };
};

const count = async (endpoint: string, status: string) =>
    (await lidarrApiCallsTotal.get()).values.find(
        (v) => v.labels.endpoint === endpoint && v.labels.status === status
    )?.value ?? 0;

it("counts each call under its path with ids folded", async () => {
    await client.get("/api/v1/album/7?includeAllArtistAlbums=true");
    await client.put("/api/v1/album/8", {});

    expect(await count("/api/v1/album/:id", "success")).toBe(2);
    const timed = (await lidarrApiDuration.get()).values.find(
        (v) => v.labels.endpoint === "/api/v1/album/:id" && v.metricName?.endsWith("_count")
    );
    expect(timed?.value).toBe(2);
});

it("counts a failed call as failed", async () => {
    await expect(client.get("/api/v1/missing/3")).rejects.toThrow("Not found");

    expect(await count("/api/v1/missing/:id", "failed")).toBe(1);
});
