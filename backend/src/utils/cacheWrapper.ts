import { redisClient } from './redis';
import { logger } from './logger';
import { cacheHits, cacheMisses, cacheOperations } from './metrics';

export class CacheWrapper {
    constructor(private cacheName: string) {}

    async get<T>(key: string): Promise<T | null> {
        try {
            cacheOperations.inc({ cache_name: this.cacheName, operation: 'get' });

            const cached = await redisClient.get(key);

            if (cached) {
                cacheHits.inc({ cache_name: this.cacheName });
                return JSON.parse(cached) as T;
            }

            cacheMisses.inc({ cache_name: this.cacheName });
            return null;
        } catch (error) {
            logger.error(`Cache get error (${this.cacheName}):`, error);
            cacheMisses.inc({ cache_name: this.cacheName });
            return null;
        }
    }

    async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        try {
            cacheOperations.inc({ cache_name: this.cacheName, operation: 'set' });

            const serialized = JSON.stringify(value);

            if (ttlSeconds) {
                await redisClient.setex(key, ttlSeconds, serialized);
            } else {
                await redisClient.set(key, serialized);
            }
        } catch (error) {
            logger.error(`Cache set error (${this.cacheName}):`, error);
        }
    }
}
