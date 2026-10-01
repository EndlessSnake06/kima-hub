"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Search,
    Loader2,
    Music2,
    Link2,
    X,
    ChevronRight,
    Info,
    ArrowLeft,
} from "lucide-react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/hooks/useDialog";
import { MediaCard } from "@/components/cards/MediaCard";
import { TileCard } from "@/components/cards/TileCard";
import { plural } from "@/lib/format";

interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface Genre {
    id: number;
    name: string;
    imageUrl: string | null;
}

const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

type BrowseTab = "playlists" | "genres";

export default function BrowsePlaylistsPage() {

    const [activeTab, setActiveTab] = useState<BrowseTab>("playlists");
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [showUrlModal, setShowUrlModal] = useState(false);
    const urlDialogRef = useRef<HTMLDivElement>(null);
    const closeUrlModal = useCallback(() => setShowUrlModal(false), []);
    useDialog(urlDialogRef, showUrlModal, closeUrlModal);
    const [urlInput, setUrlInput] = useState("");
    const [isParsing, setIsParsing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [playlists, setPlaylists] = useState<PlaylistPreview[]>([]);
    const [genres, setGenres] = useState<Genre[]>([]);
    const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
    const [genrePlaylists, setGenrePlaylists] = useState<PlaylistPreview[]>([]);

    const fetchAllContent = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                genres: Genre[];
            }>("/browse/all");
            setPlaylists(response.playlists);
            setGenres(response.genres);
        } catch (error) {
            console.error("Failed to fetch browse content:", error);
            setLoadError(
                "Couldn't load playlists. Check your connection and try again.",
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAllContent();
    }, [fetchAllContent]);

    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!searchQuery.trim() || searchQuery.length < 2) {
            if (!searchQuery.trim()) setHasSearched(false);
            return;
        }

        setIsSearching(true);
        setHasSearched(true);
        setActiveTab("playlists");

        try {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/playlists/search?q=${encodeURIComponent(searchQuery)}&limit=100`,
            );
            setPlaylists(response.playlists);
        } catch (error) {
            console.error("Search failed:", error);
            notify.error("Failed to search playlists");
        } finally {
            setIsSearching(false);
        }
    };

    const clearSearch = () => {
        setSearchQuery("");
        setHasSearched(false);
        fetchAllContent();
    };

    const handleUrlSubmit = async () => {
        if (!urlInput.trim()) return;
        setIsParsing(true);

        try {
            // Parse URL first to validate it
            const response = await api.post<{
                source: string;
                id: string;
                url: string;
            }>("/browse/playlists/parse", { url: urlInput.trim() });

            // Fire background import
            await api.post<{ jobId: string }>("/spotify/import/quick", {
                url: response.url,
            });

            setShowUrlModal(false);
            setUrlInput("");
        } catch (error: unknown) {
            notify.error("Couldn't import playlist", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsParsing(false);
        }
    };

    const handleGenreClick = async (genre: Genre) => {
        setSelectedGenre(genre);
        setIsLoading(true);

        try {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/genres/${genre.id}/playlists?limit=50`,
            );
            setGenrePlaylists(response.playlists);
        } catch (error) {
            console.error("Failed to fetch genre playlists:", error);
            notify.error("Failed to load genre playlists");
        } finally {
            setIsLoading(false);
        }
    };

    const handleBackFromGenre = () => {
        setSelectedGenre(null);
        setGenrePlaylists([]);
    };

    const renderCard = (
        item: PlaylistPreview,
        index: number,
        context?: string,
    ) => (
        <MediaCard
            key={`${item.source}-${item.type}-${item.id}-${context || "main"}-${index}`}
            href={`/browse/playlists/${item.id}`}
            title={item.title}
            subtitle={`${plural(item.trackCount, "song")} · ${item.creator}`}
            imageUrl={item.imageUrl}
            fallbackIcon={Music2}
            type="track"
            index={index}
        />
    );

    const renderGenreCard = (genre: Genre, index: number) => (
        <TileCard
            key={genre.id}
            title={genre.name}
            imageUrl={genre.imageUrl}
            tint="from-type-track/30 to-type-track/10"
            hoverBorder="hover:border-type-track/40"
            accent="from-type-track to-type-track"
            onClick={() => handleGenreClick(genre)}
            index={index}
            className="aspect-square"
        />
    );

    if (isLoading && !selectedGenre && !hasSearched) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    let sectionIndex = 0;

    return (
        <div className="min-h-screen">
            <div className="section-stack">
                <PageHeader
                    eyebrow="From Deezer"
                    title="Browse playlists"
                    description="Find playlists on Deezer and import them into your library"
                    className="pb-2"
                />

                <div className="relative page-shell pb-24 animate-rise">
                    {/* Beta Notice */}
                    <div
                        className="mb-6"

                    >
                        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-type-track/5 border border-type-track/20">
                            <Info className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                            <p className="text-xs tabular-nums text-[var(--text-secondary)] leading-relaxed">
                                <span className="font-bold text-brand">
                                    Beta
                                </span>{" "}
                                · Importing from Spotify and Deezer relies on
                                matching tracks through Soulseek and your
                                configured indexers. Results may vary depending
                                on track availability and metadata quality.
                            </p>
                        </div>
                    </div>

                    {/* Search Bar & Import URL */}
                    <div
                        className="flex items-center gap-3 mb-6"

                    >
                        <form
                            onSubmit={handleSearch}
                            className="relative flex-1 max-w-md"
                        >
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search playlists..."
                                aria-label="Search playlists"
                                className="w-full bg-white/5 border border-white/10 rounded-lg pl-11 pr-10 py-2.5 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-brand/40 transition-all tabular-nums"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={clearSearch}
                                    aria-label="Clear search"
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-white transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </form>

                        <button
                            onClick={() => setShowUrlModal(true)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs font-semibold text-[var(--text-secondary)] hover:text-white transition-all"
                        >
                            <Link2 className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Import URL</span>
                        </button>
                    </div>

                    {/* Tabs */}
                    {!selectedGenre && !hasSearched && (
                        <div
                            className="flex items-center gap-2 mb-8"

                        >
                            <button
                                onClick={() => setActiveTab("playlists")}
                                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                                    activeTab === "playlists" ?
                                        "bg-brand text-black"
                                    :   "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                }`}
                            >
                                Playlists
                            </button>
                            <button
                                onClick={() => setActiveTab("genres")}
                                className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                                    activeTab === "genres" ?
                                        "bg-brand text-black"
                                    :   "bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                }`}
                            >
                                Genres
                            </button>
                        </div>
                    )}

                    {/* Genre Breadcrumb */}
                    {selectedGenre && (
                        <div className="flex items-center gap-2 mb-6">
                            <button
                                onClick={handleBackFromGenre}
                                className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Genres
                            </button>
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            <span className="text-xs font-semibold text-white tracking-tight">
                                {selectedGenre.name}
                            </span>
                        </div>
                    )}

                    {/* Loading State */}
                    {(isLoading || isSearching) && !loadError && (
                        <div className="flex items-center justify-center py-24">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {/* Error State */}
                    {loadError && !isLoading && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-white/10 mb-4" />
                            <h3 className="text-lg font-bold text-white mb-2 tracking-tight">
                                Couldn&apos;t load content
                            </h3>
                            <p className="text-xs tabular-nums text-[var(--text-muted)] mb-6 max-w-sm">
                                {loadError}
                            </p>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={fetchAllContent}
                            >
                                Try again
                            </Button>
                        </div>
                    )}

                    {/* Search Results */}
                    {!isLoading && !isSearching && hasSearched && (
                        <div

                        >
                            <SectionHeader type="track"
                                title={`Results for "${searchQuery}"`}
                                count={playlists.length}
                            />
                            {playlists.length === 0 ?
                                <div className="flex flex-col items-center justify-center py-20 text-center">
                                    <h3 className="text-lg font-bold text-white mb-2 tracking-tight">
                                        No playlists found
                                    </h3>
                                    <p className="text-xs text-[var(--text-muted)] mb-4">
                                        Try a different search or import a URL
                                        directly
                                    </p>
                                    <button
                                        onClick={() => setShowUrlModal(true)}
                                        className="px-6 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-black text-xs font-semibold transition-all"
                                    >
                                        Import by URL
                                    </button>
                                </div>
                            :   <div className="grid-media">
                                    {playlists.map((item, idx) =>
                                        renderCard(item, idx, "search"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

                    {/* Genre Playlists View */}
                    {!isLoading && selectedGenre && (
                        <div

                        >
                            <SectionHeader type="track"
                                title={`${selectedGenre.name} Playlists`}
                                count={genrePlaylists.length}
                            />
                            {genrePlaylists.length === 0 ?
                                <p className="text-xs text-[var(--text-muted)]">
                                    No playlists found for this genre
                                </p>
                            :   <div className="grid-media">
                                    {genrePlaylists.map((item, idx) =>
                                        renderCard(item, idx, "genre"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

                    {/* Main Content */}
                    {!isLoading &&
                        !isSearching &&
                        !hasSearched &&
                        !selectedGenre && (
                            <>
                                {activeTab === "playlists" && (
                                    <div

                                        style={{
                                            animationDelay: `${sectionIndex++ * 0.1}s`,
                                        }}
                                    >
                                        <SectionHeader type="track"
                                            title="Featured Playlists"
                                            count={playlists.length}
                                        />
                                        <div className="grid-media">
                                            {playlists.map((item, idx) =>
                                                renderCard(
                                                    item,
                                                    idx,
                                                    "featured",
                                                ),
                                            )}
                                        </div>
                                        {playlists.length >= 20 && (
                                            <p className="text-center text-xs tabular-nums text-[var(--text-muted)] mt-8">
                                                Showing {playlists.length}{" "}
                                                playlists -- Search for more or
                                                import by URL
                                            </p>
                                        )}
                                    </div>
                                )}

                                {activeTab === "genres" && (
                                    <div

                                        style={{
                                            animationDelay: `${sectionIndex++ * 0.1}s`,
                                        }}
                                    >
                                        <SectionHeader type="track"
                                            title="Browse by Genre"
                                            count={genres.length}
                                        />
                                        <div className="grid-media">
                                            {genres.map(renderGenreCard)}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                </div>
            </div>

            {/* URL Import Modal */}
            {showUrlModal && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-(--z-modal) p-4 animate-in fade-in duration-200"
                    onClick={() => setShowUrlModal(false)}
                >
                    <div
                        ref={urlDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="url-import-title"
                        className="bg-[var(--bg-secondary)] rounded-lg max-w-lg w-full border border-white/10 animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="relative px-6 pt-6 pb-4 border-b border-white/10">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                aria-label="Close import modal"
                                className="absolute top-4 right-4 p-2 hover:bg-white/5 rounded-lg transition-colors"
                            >
                                <X className="w-4 h-4 text-[var(--text-muted)] hover:text-white transition-colors" />
                            </button>

                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-8 h-8 rounded-lg bg-type-track flex items-center justify-center">
                                    <Link2 className="w-4 h-4 text-white" />
                                </div>
                                <h3 id="url-import-title" className="text-lg font-bold text-white tracking-tight">
                                    Import Playlist
                                </h3>
                            </div>
                            <p className="text-xs text-[var(--text-muted)] ml-11">
                                Paste a link to get started
                            </p>
                        </div>

                        {/* Supported platforms */}
                        <div className="px-6 py-4">
                            <div className="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg border border-white/5">
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-spotify/10 rounded border border-spotify/20">
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="w-3.5 h-3.5 text-spotify"
                                        fill="currentColor"
                                    >
                                        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                    </svg>
                                    <span className="text-xs font-semibold text-spotify">
                                        Spotify
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-type-track/10 rounded border border-type-track/20">
                                    <DeezerIcon className="w-3.5 h-3.5 text-brand" />
                                    <span className="text-xs font-semibold text-brand">
                                        Deezer
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-[#FF0000]/10 rounded border border-[#FF0000]/20">
                                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[#FF0000]" fill="currentColor">
                                        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                                    </svg>
                                    <span className="text-xs font-semibold text-[#FF0000]">
                                        YouTube
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-[#FF5500]/10 rounded border border-[#FF5500]/20">
                                    <span className="text-xs font-semibold text-[#FF5500]">
                                        SC
                                    </span>
                                </div>
                                <span className="text-xs text-[var(--text-muted)] ml-auto">
                                    +more
                                </span>
                            </div>
                        </div>

                        {/* Input */}
                        <div className="px-6 pb-4">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={(e) =>
                                        setUrlInput(e.target.value)
                                    }
                                    placeholder="Paste a playlist URL (Spotify, YouTube, SoundCloud...)"
                                    className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-brand/40 transition-all tabular-nums"
                                    onKeyDown={(e) =>
                                        e.key === "Enter" && handleUrlSubmit()
                                    }
                                    autoFocus
                                />
                                {urlInput && (
                                    <button
                                        onClick={() => setUrlInput("")}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-white/5 rounded transition-colors"
                                    >
                                        <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                                    </button>
                                )}
                            </div>
                            <p className="text-xs text-[var(--text-muted)] mt-2 ml-1">
                                Spotify, Deezer, YouTube, SoundCloud, Bandcamp, Mixcloud
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="px-6 pb-6 flex gap-3">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="flex-1 py-3 rounded-lg bg-white/5 border border-white/10 text-xs font-semibold text-[var(--text-secondary)] hover:bg-white/10 hover:text-white transition-all"
                            >
                                Cancel
                            </button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleUrlSubmit}
                                disabled={isParsing || !urlInput.trim()}
                                className="flex-1"
                            >
                                {isParsing ?
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        <span>Importing...</span>
                                    </>
                                :   <>
                                        <ChevronRight className="w-3.5 h-3.5" />
                                        <span>Continue</span>
                                    </>
                                }
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
