"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePodcastQuery } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Podcast, PodcastPreview, SimilarPodcast, Episode } from "../types";
import { subscribeQueryEvent } from "@/lib/query-events";

export function usePodcastData() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const podcastId = params.id as string;

  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(
        `kima_podcast_sort_order_${podcastId}`
      );
      return (saved as "newest" | "oldest") || "newest";
    }
    return "newest";
  });

  // Use React Query hook for podcast
  const {
    data: podcast,
    isLoading: isPodcastLoading,
    isPlaceholderData: episodesUpdating,
    refetch,
    hasMore,
    loadMore,
    loadingMore,
  } = usePodcastQuery(podcastId, sortOrder);

  // Listen for podcast-progress-updated event (fired when playback starts/updates or episode marked complete)
  useEffect(() => {
    // Progress saves every 15 s while an episode plays; a refetch must not
    // cancel a "show more" already loading.
    const unsubscribe = subscribeQueryEvent("podcast-progress-updated", () => {
      refetch({ cancelRefetch: false });
    });

    return unsubscribe;
  }, [refetch]);

  // State for preview mode, subscription, and similar podcasts
  const [previewData, setPreviewData] = useState<PodcastPreview | null>(null);
  const [previewLoadState, setPreviewLoadState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [similarPodcasts, setSimilarPodcasts] = useState<SimilarPodcast[]>([]);

  // Reset preview/error state when navigating between podcasts so a previous
  // page's error UI does not sticky-state into the next podcast's view.
  const [prevPodcastId, setPrevPodcastId] = useState(podcastId);
  if (prevPodcastId !== podcastId) {
    setPrevPodcastId(podcastId);
    setPreviewLoadState('idle');
    setPreviewError(null);
    setPreviewData(null);
    setSimilarPodcasts([]);
  }

  // Get raw cover URL
  const rawCoverUrl = podcast?.coverUrl || previewData?.coverUrl;
  const heroImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 1200) : null;
  // Separate URL with token for color extraction (CORS access for canvas)
  const colorExtractionImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 300, true) : null;

  // Load similar podcasts when podcast data is available
  useEffect(() => {
    if (!podcast?.id || !isAuthenticated) return;

    let cancelled = false;

    async function loadSimilarPodcasts() {
      try {
        const similar = await api.getSimilarPodcasts(podcastId);
        if (!cancelled) setSimilarPodcasts(similar);
      } catch (error) {
        if (!cancelled) console.error("Failed to load similar podcasts:", error);
      }
    }

    loadSimilarPodcasts();
    return () => { cancelled = true; };
  }, [podcast?.id, isAuthenticated, podcastId]);

  // An unsubscribed podcast is shown from its directory preview instead.
  useEffect(() => {
    if (isPodcastLoading || podcast || !isAuthenticated) return;

    let cancelled = false;

    async function loadPreviewData() {
      setPreviewLoadState('loading');
      try {
        const preview = await api.previewPodcast(podcastId);
        if (cancelled) return;
        setPreviewData(preview);
        setPreviewLoadState('done');

        if (preview.isSubscribed && preview.subscribedPodcastId) {
          router.replace(`/podcasts/${preview.subscribedPodcastId}`);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load preview:", err);
          setPreviewLoadState('error');
          setPreviewError(err instanceof Error ? err.message : "Could not load podcast");
        }
      }
    }

    loadPreviewData();
    return () => { cancelled = true; };
  }, [isPodcastLoading, podcast, isAuthenticated, podcastId, router]);

  // Save sort order to localStorage when it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        `kima_podcast_sort_order_${podcastId}`,
        sortOrder
      );
    }
  }, [sortOrder, podcastId]);

  // Computed values
  const displayData = podcast || (previewData ? {
    title: previewData.title,
    author: previewData.author,
    description: previewData.description,
    coverUrl: previewData.coverUrl,
    genres: previewData.genres,
    episodes: [],
  } : null);

  const inProgressEpisodes = podcast
    ? podcast.episodes.filter(
        (ep: Episode) =>
          ep.progress &&
          !ep.progress.isFinished &&
          ep.progress.currentTime > 0
      )
    : [];

  // The server pages from the end that was asked for; render in the order it arrived.
  const sortedEpisodes = podcast ? [...podcast.episodes] : [];

  // Determine loading state:
  // - Loading if podcast query is loading
  // - Loading if podcast query done but no podcast and we haven't tried/finished preview yet
  const needsPreviewLoad = !podcast && previewLoadState === 'idle';
  const isLoadingPreview = previewLoadState === 'loading';
  const isLoading = isPodcastLoading || needsPreviewLoad || isLoadingPreview;

  return {
    podcastId,
    podcast: podcast as Podcast | undefined,
    previewData,
    previewLoadState,
    previewError,
    displayData,
    isLoading,
    heroImage,
    colorExtractionImage,
    similarPodcasts,
    sortOrder,
    setSortOrder,
    inProgressEpisodes,
    sortedEpisodes,
    episodesUpdating,
    hasMore,
    loadMore,
    loadingMore,
  };
}
