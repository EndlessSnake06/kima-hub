import { logger } from "../utils/logger";

type SSEEventType =
    | "notification"
    | "notification:cleared"
    | "notification:read"
    | "download:progress"
    | "download:queued"
    | "download:complete"
    | "download:failed"
    | "search:result"
    | "search:complete"
    | "scan:progress"
    | "scan:complete"
    | "import:progress"
    | "discover:progress"
    | "discover:complete"
    | "preview:progress"
    | "preview:complete"
    | "enrichment:progress"
    | "playlist:updated";

export interface SSEEvent {
    type: SSEEventType;
    /** Recipient, or "*" to broadcast to every connected client. */
    userId: string;
    payload: Record<string, unknown>;
}

/**
 * One connected SSE client. `send` returns false once the connection cannot
 * take data, and the bus drops the subscriber on the spot.
 */
export interface SSESubscriber {
    send(event: SSEEvent): boolean;
}

/** Routes each event to its user's clients through a per-user registry. */
class EventBus {
    private byUser = new Map<string, Set<SSESubscriber>>();

    subscribe(userId: string, subscriber: SSESubscriber): () => void {
        let set = this.byUser.get(userId);
        if (!set) {
            set = new Set();
            this.byUser.set(userId, set);
        }
        set.add(subscriber);

        return () => {
            const current = this.byUser.get(userId);
            if (!current) return;
            current.delete(subscriber);
            if (current.size === 0) this.byUser.delete(userId);
        };
    }

    /** Remove a subscriber, and the user's entry once it has none left. */
    private drop(set: Set<SSESubscriber>, subscriber: SSESubscriber): void {
        set.delete(subscriber);
        if (set.size > 0) return;
        for (const [userId, candidate] of this.byUser) {
            if (candidate === set) {
                this.byUser.delete(userId);
                return;
            }
        }
    }

    /** How many clients this user currently has connected. */
    connectionCount(userId: string): number {
        return this.byUser.get(userId)?.size ?? 0;
    }

    /** Total connected clients, for diagnostics. */
    totalConnections(): number {
        let n = 0;
        for (const set of this.byUser.values()) n += set.size;
        return n;
    }

    emit(event: SSEEvent): void {
        const targets: Set<SSESubscriber>[] = [];
        if (event.userId === "*") {
            targets.push(...this.byUser.values());
        } else {
            const set = this.byUser.get(event.userId);
            if (set) targets.push(set);
        }

        for (const set of targets) {
            // Copy before iterating: a failed send unsubscribes, mutating the set.
            for (const subscriber of [...set]) {
                try {
                    if (!subscriber.send(event)) {
                        this.drop(set, subscriber);
                    }
                } catch (error) {
                    logger.error("[EventBus] Subscriber error:", error);
                    this.drop(set, subscriber);
                }
            }
        }
    }
}

export const eventBus = new EventBus();
