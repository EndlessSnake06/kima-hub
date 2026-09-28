import {
    artistQueue,
    podcastQueue,
    trackQueue,
    vibeQueue,
} from "../../workers/enrichmentQueues";
import { enrichmentStateService } from "../../services/enrichmentState";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../utils/closeQueue";

/**
 * Close what a bare import of the enrichment modules opens: the four BullMQ
 * queues built at module scope in enrichmentQueues, the enrichmentState
 * singleton's two clients, and the shared Redis client. Left open, Jest
 * finishes the suite and then outlives it on those sockets.
 */
export async function closeEngineConnections(): Promise<void> {
    await Promise.all([
        closeQueue(artistQueue),
        closeQueue(trackQueue),
        closeQueue(vibeQueue),
        closeQueue(podcastQueue),
        enrichmentStateService.disconnect(),
    ]);
    await closeClient(redisClient);
}
