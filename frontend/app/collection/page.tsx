"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioControls } from "@/lib/audio-controls-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tab, DeleteDialogState } from "@/features/library/types";
import {
    useLibraryArtistsQuery,
    useLibraryAlbumsQuery,
    useLibraryTracksQuery,
    LibraryFilter,
    SortOption,
} from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useLibraryActions } from "@/features/library/hooks/useLibraryActions";
import { PageHeader } from "@/components/layout/PageHeader";
import { LibraryTabs } from "@/features/library/components/LibraryTabs";
import { LibraryToolbar } from "@/features/library/components/LibraryToolbar";
import { ArtistsGrid } from "@/features/library/components/ArtistsGrid";
import { AlbumsGrid } from "@/features/library/components/AlbumsGrid";
import { TracksList } from "@/features/library/components/TracksList";
import { Pagination } from "@/components/ui/Pagination";
import { latchTotal, parsePageParam } from "@/lib/pagination";

function libraryUrl(tab: Tab, page?: number): string {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (page && page > 1) params.set("page", String(page));
    return `/collection?${params.toString()}`;
}

export default function LibraryPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { playTracks } = useAudioControls();

    // Get active tab from URL params, default to "artists"
    const validTabs: Tab[] = ["artists", "albums", "tracks"];
    const tabParam = searchParams.get("tab");
    const activeTab: Tab = validTabs.includes(tabParam as Tab) ? (tabParam as Tab) : "artists";

    // Page lives in the URL and nowhere else. Reading it through
    // parsePageParam means a garbage ?page= never reaches the API, and the
    // pager math never sees NaN.
    const currentPage = parsePageParam(searchParams.get("page"));

    // Filter state (owned = your library, discovery = discovery weekly artists)
    const [filter, setFilter] = useState<LibraryFilter>("owned");

    // Sort and pagination state
    const [sortBy, setSortBy] = useState<SortOption>("name");
    const [itemsPerPage, setItemsPerPage] = useState<number>(40);

    const shownPageRef = useRef(currentPage);

    // Last total seen per tab. A query that fails on its first load has no
    // data; the latch keeps the pager standing on the last real count instead
    // of recomputing the list down to zero pages.
    const [latchedTotals, setLatchedTotals] = useState<Partial<Record<Tab, number>>>({});

    const queryClient = useQueryClient();

    // Use React Query hooks for cached data fetching
    // Only fetch data for active tab to prevent unnecessary API calls
    const artistsQuery = useLibraryArtistsQuery({
        filter,
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "artists",
    });

    const albumsQuery = useLibraryAlbumsQuery({
        filter,
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "albums",
    });

    const tracksQuery = useLibraryTracksQuery({
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "tracks",
    });

    // The server returns this list already ordered by the article-stripped
    // `Artist.sortName`, across all pages. Do not re-sort here.
    const artists = useMemo(() => {
        if (activeTab !== "artists") {
            return [];
        }

        return artistsQuery.data?.artists ?? [];
    }, [activeTab, artistsQuery.data?.artists]);




    const albums = useMemo(
        () => (activeTab === "albums" ? (albumsQuery.data?.albums ?? []) : []),
        [activeTab, albumsQuery.data?.albums],
    );
    const tracks = useMemo(
        () => (activeTab === "tracks" ? (tracksQuery.data?.tracks ?? []) : []),
        [activeTab, tracksQuery.data?.tracks],
    );

    // Loading state based on active tab
    const isLoading =
        (activeTab === "artists" && artistsQuery.isLoading) ||
        (activeTab === "albums" && albumsQuery.isLoading) ||
        (activeTab === "tracks" && tracksQuery.isLoading);


    // `fresh` is undefined while the query has no data (loading, or a failed
    // first load). The latch keeps the last real total, and totalPages is
    // floored at 1 so the pager never disappears.
    const fresh =
        activeTab === "artists" ? artistsQuery.data?.total
        : activeTab === "albums" ? albumsQuery.data?.total
        : tracksQuery.data?.total;
    const total = latchTotal(latchedTotals[activeTab] ?? 0, fresh);
    if (total !== (latchedTotals[activeTab] ?? 0)) {
        setLatchedTotals((prev) => ({ ...prev, [activeTab]: total }));
    }

    const activeQuery =
        activeTab === "artists" ? artistsQuery
        : activeTab === "albums" ? albumsQuery
        : tracksQuery;

    // The previous page stays on screen until the next one arrives, so the
    // jump to the top waits for the swap; scrolling on the click shows the
    // old page's top for the length of the request.
    const pageDataReady =
        activeQuery.data !== undefined && !activeQuery.isPlaceholderData;
    useLayoutEffect(() => {
        if (!pageDataReady || shownPageRef.current === currentPage) return;
        shownPageRef.current = currentPage;
        document.getElementById("main-content")?.scrollTo({ top: 0, behavior: "instant" });
    }, [pageDataReady, currentPage]);

    const pagination = useMemo(
        () => ({
            total,
            offset: 0,
            limit: itemsPerPage,
            totalPages: Math.max(1, Math.ceil(total / itemsPerPage)),
            currentPage,
            itemsPerPage,
        }),
        [total, itemsPerPage, currentPage],
    );

    // Reload data function using React Query invalidation
    const reloadData = useCallback(async () => {
        if (activeTab === "artists") {
            await queryClient.invalidateQueries({
                queryKey: ["library", "artists"],
            });
        } else if (activeTab === "albums") {
            await queryClient.invalidateQueries({
                queryKey: ["library", "albums"],
            });
        } else {
            await queryClient.invalidateQueries({
                queryKey: ["library", "tracks"],
            });
        }
    }, [activeTab, queryClient]);

    const {
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteArtist,
        deleteAlbum,
        deleteTrack,
    } = useLibraryActions();

    // Increments on tab/filter/sort change to remount grids and replay the
    // entrance animation. Declared above the effects that set it.
    const [gridKey, setGridKey] = useState(0);

    // A tab switch pushes a page-less URL, so the page resets on its own; here
    // the tracks tab resets its filter and the grid remounts to replay its entrance.
    const [shownTab, setShownTab] = useState(activeTab);
    if (shownTab !== activeTab) {
        setShownTab(activeTab);
        if (activeTab === "tracks") setFilter("owned");
        setGridKey((k) => k + 1);
    }

    // Changing filter/sort/page-size invalidates the current page number, so
    // the URL loses it and the grid remounts. Done in the handlers, not an
    // effect on the state, so the URL rewrite only happens on user action.
    const resetView = useCallback(() => {
        setGridKey((k) => k + 1);
        if (currentPage !== 1) {
            router.replace(libraryUrl(activeTab, 1), { scroll: false });
        }
    }, [activeTab, currentPage, router]);

    const changeFilter = useCallback((next: LibraryFilter) => {
        setFilter(next);
        resetView();
    }, [resetView]);

    const changeSort = useCallback((next: SortOption) => {
        setSortBy(next);
        resetView();
    }, [resetView]);

    const changeItemsPerPage = useCallback((next: number) => {
        setItemsPerPage(next);
        resetView();
    }, [resetView]);

    // A ?page= past the end is moved back to the last real page once a response
    // lands. The URL stays the single source of truth, so one empty frame shows.
    const outOfRange =
        !isLoading &&
        !activeQuery.isError &&
        activeQuery.data !== undefined &&
        currentPage > pagination.totalPages;
    useEffect(() => {
        if (outOfRange) {
            router.replace(libraryUrl(activeTab, pagination.totalPages), { scroll: false });
        }
    }, [outOfRange, activeTab, pagination.totalPages, router]);

    // Get total items and pages from pagination
    const totalItems = pagination.total;
    const totalPages = pagination.totalPages;

    // Delete confirmation dialog state
    const [deleteConfirm, setDeleteConfirm] = useState<DeleteDialogState>({
        isOpen: false,
        type: "track",
        id: "",
        title: "",
    });

    // Change tab function
    const changeTab = useCallback(
        (tab: Tab) => {
            router.push(libraryUrl(tab, 1), { scroll: false });
        },
        [router],
    );

    // Update page with URL state — the URL is the page's only storage.
    const updatePage = useCallback(
        (page: number) => {
            router.push(libraryUrl(activeTab, page), { scroll: false });
        },
        [activeTab, router],
    );

    // Helper to convert library Track to audio context Track format
    const formatTracksForAudio = useCallback((libraryTracks: typeof tracks) => {
        return libraryTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            artist: {
                id: track.album?.artist?.id,
                name: track.album?.artist?.name || "Unknown Artist",
            },
            album: {
                id: track.album?.id,
                title: track.album?.title || "Unknown Album",
                coverArt: track.album?.coverArt,
            },
        }));
    }, []);

    // Wrapper for playTracks that converts track format
    const handlePlayTracks = useCallback(
        (libraryTracks: typeof tracks, startIndex?: number) => {
            const formattedTracks = formatTracksForAudio(libraryTracks);
            playTracks(formattedTracks, startIndex);
        },
        [formatTracksForAudio, playTracks],
    );

    // Shuffle entire library - uses server-side shuffle for large libraries
    const handleShuffleLibrary = useCallback(async () => {
        try {
            // Use server-side shuffle endpoint for better performance with large libraries
            const { tracks: shuffledTracks } = await api.getShuffledTracks(500);

            if (shuffledTracks.length === 0) {
                return;
            }

            const formattedTracks = formatTracksForAudio(shuffledTracks);
            playTracks(formattedTracks, 0);
        } catch (error) {
            console.error("Failed to shuffle library:", error);
        }
    }, [formatTracksForAudio, playTracks]);

    // Handle delete confirmation
    const handleDelete = useCallback(async () => {
        try {
            switch (deleteConfirm.type) {
                case "artist":
                    await deleteArtist(deleteConfirm.id);
                    break;
                case "album":
                    await deleteAlbum(deleteConfirm.id);
                    break;
                case "track":
                    await deleteTrack(deleteConfirm.id);
                    break;
            }

            // Reload data and close dialog - the item disappearing is feedback enough
            await reloadData();
            setDeleteConfirm({
                isOpen: false,
                type: "track",
                id: "",
                title: "",
            });
        } catch (error) {
            console.error(`Failed to delete ${deleteConfirm.type}:`, error);
            // Keep dialog open on error so user can retry
        }
    }, [deleteConfirm, deleteArtist, deleteAlbum, deleteTrack, reloadData]);

    // Memoize delete handlers to prevent grid re-renders
    const handleDeleteArtist = useCallback((id: string, name: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "artist",
            id,
            title: name,
        });
    }, []);

    const handleDeleteAlbum = useCallback((id: string, title: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "album",
            id,
            title,
        });
    }, []);

    const handleDeleteTrack = useCallback((id: string, title: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "track",
            id,
            title,
        });
    }, []);

    return (
        <div className="min-h-screen">
            <PageHeader
                eyebrow="Your library"
                title="Collection"
                description={`${totalItems.toLocaleString()} ${activeTab === "artists" ? "artists" : activeTab === "albums" ? "albums" : "tracks"}`}
            />

            <div className="relative page-shell pb-24">
                <div className="mb-6">
                    <LibraryTabs
                        activeTab={activeTab}
                        onTabChange={changeTab}
                    />
                </div>

                {/* Toolbar */}
                <div className="mb-8">
                    <LibraryToolbar
                        activeTab={activeTab}
                        filter={filter}
                        sortBy={sortBy}
                        itemsPerPage={itemsPerPage}
                        onFilterChange={changeFilter}
                        onSortChange={changeSort}
                        onItemsPerPageChange={changeItemsPerPage}
                        onShuffleLibrary={handleShuffleLibrary}
                    />
                </div>

                <div
                    aria-busy={activeQuery.isPlaceholderData}
                    className={`transition-opacity duration-150 ${activeQuery.isPlaceholderData ? "opacity-50" : ""}`}
                >
                    {activeTab === "artists" && (
                        <ArtistsGrid
                            key={gridKey}
                            artists={artists}
                            isLoading={isLoading}
                            onPlay={playArtist}
                            onDelete={handleDeleteArtist}
                            gridKey={gridKey}
                        />
                    )}

                    {activeTab === "albums" && (
                        <AlbumsGrid
                            key={gridKey}
                            albums={albums}
                            isLoading={isLoading}
                            onPlay={playAlbum}
                            onDelete={handleDeleteAlbum}
                            gridKey={gridKey}
                        />
                    )}

                    {activeTab === "tracks" && (
                        <TracksList
                            key={gridKey}
                            tracks={tracks}
                            isLoading={isLoading}
                            onPlay={handlePlayTracks}
                            onAddToQueue={addTrackToQueue}
                            onAddToPlaylist={addTrackToPlaylist}
                            onDelete={handleDeleteTrack}
                            gridKey={gridKey}
                        />
                    )}
                </div>

                {activeQuery.isError && !isLoading && (
                    <div
                        role="status"
                        className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 mb-6 -mt-6"
                    >
                        <p className="text-sm text-[var(--text-secondary)]">
                            Couldn&apos;t load this page. The pager shows the last known count —
                            nothing was deleted.
                        </p>
                        <button
                            type="button"
                            onClick={() => void activeQuery.refetch()}
                            disabled={activeQuery.isFetching}
                            className="text-sm font-medium text-white underline underline-offset-4 hover:text-[var(--text-secondary)] disabled:opacity-50 whitespace-nowrap"
                        >
                            {activeQuery.isFetching ? "Retrying…" : "Retry"}
                        </button>
                    </div>
                )}

                <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={updatePage}
                    disabled={isLoading}
                    label={
                        activeTab === "artists" ? "Artists"
                        : activeTab === "albums" ? "Albums"
                        : "Tracks"
                    }
                />

                <ConfirmDialog
                    isOpen={deleteConfirm.isOpen}
                    onClose={() =>
                        setDeleteConfirm({
                            isOpen: false,
                            type: "track",
                            id: "",
                            title: "",
                        })
                    }
                    onConfirm={handleDelete}
                    title={`Delete ${
                        deleteConfirm.type === "artist" ? "Artist"
                        : deleteConfirm.type === "album" ? "Album"
                        : "Track"
                    }?`}
                    message={
                        deleteConfirm.type === "track" ?
                            `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete the file from your system.`
                        : deleteConfirm.type === "album" ?
                            `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all tracks and files from your system.`
                        :   `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all albums, tracks, and files from your system.`

                    }
                    confirmText="Delete"
                    cancelText="Cancel"
                    variant="danger"
                />
            </div>
        </div>
    );
}
