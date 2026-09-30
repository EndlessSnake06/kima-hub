/**
 * Query Events - Typed event system for cache invalidation
 * 
 * Provides a type-safe wrapper around CustomEvent for triggering React Query cache invalidation.
 * Events are dispatched when data changes and listeners refetch queries to update the UI.
 */

/**
 * Available query event types
 */
export type QueryEventType =
    | "audiobook-progress-updated"
    | "podcast-progress-updated"
    | "mixes-updated";

/**
 * Event payload interface - can be extended for event-specific data
 */
export interface QueryEventDetail {
    [key: string]: unknown;
}

/** Dispatch a typed query event. */
export function dispatchQueryEvent(
    eventType: QueryEventType,
    detail?: QueryEventDetail
): void {
    window.dispatchEvent(
        new CustomEvent(eventType, { detail: detail || {} })
    );
}

/** Subscribe to a typed query event; returns the unsubscribe function. */
export function subscribeQueryEvent(
    eventType: QueryEventType,
    handler: (event: CustomEvent<QueryEventDetail>) => void
): () => void {
    const listener = handler as EventListener;
    window.addEventListener(eventType, listener);
    
    return () => {
        window.removeEventListener(eventType, listener);
    };
}
