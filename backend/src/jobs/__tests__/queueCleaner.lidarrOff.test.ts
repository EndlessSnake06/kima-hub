/**
 * With Lidarr switched off in settings, the queue cleaner stops at once and
 * never calls Lidarr, even when an address and key are still saved. Real
 * database, against a real Lidarr's recorded answers.
 */

import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { queueCleaner } from "../queueCleaner";

let lidarr: LidarrReplay;

beforeAll(async () => {
    lidarr = await startLidarrReplay(loadScenario("complete"));
});

afterAll(async () => {
    queueCleaner.stop();
    await lidarr.close();
    await closeEngineConnections();
});

it("stops without asking Lidarr anything when Lidarr is off", async () => {
    await useLidarr(lidarr.url, { lidarrEnabled: false });
    await queueCleaner.start();

    expect(queueCleaner.getStatus().isRunning).toBe(false);
    expect(lidarr.asked).toEqual([]);
});
