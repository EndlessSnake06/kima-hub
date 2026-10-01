"use client";

import { useState, useEffect, useMemo } from "react";
import { Calendar, Clock, Download, Disc, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { CachedImage } from "@/components/ui/CachedImage";
import { plural } from "@/lib/format";
import { PageMessage } from "@/components/ui/PageMessage";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr' | 'similar';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

export default function ReleasesPage() {
    const [data, setData] = useState<ReleaseRadarData | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloadingId, setDownloadingId] = useState<string | number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const fetchReleases = async () => {
        try {
            setLoading(true);
            const json = await api.get<ReleaseRadarData>("/releases/radar?daysBack=30&daysAhead=90");
            setData(json);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to fetch releases");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReleases();
    }, []);

    const handleDownload = async (albumMbid: string, releaseId: string | number) => {
        try {
            setDownloadingId(releaseId);
            await api.post(`/releases/download/${albumMbid}`);
            await fetchReleases();
        } catch (err) {
            console.error("Download failed:", err);
        } finally {
            setDownloadingId(null);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Tomorrow";
        if (diffDays > 0 && diffDays <= 7) return `In ${diffDays} days`;
        if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;

        return date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error) {
        return (
            <PageMessage
                title="Couldn't load releases"
                description={error}
                action={{ label: "Try again", onClick: () => { setError(null); fetchReleases(); } }}
            />
        );
    }

    return (
        <div className="min-h-screen pb-32">
            <PageHeader
                eyebrow="Release radar"
                title="New and upcoming"
                description={
                    data?.monitoredArtistCount
                        ? [
                              plural(data.monitoredArtistCount, "monitored artist"),
                              `${data.upcoming.length} upcoming`,
                              `${data.recent.length} recent`,
                          ].join(" · ")
                        : undefined
                }
            />

            <div className="page-shell space-y-10 animate-rise">
                {data?.upcoming && data.upcoming.length > 0 && (
                    <section>
                        <div className="flex items-center gap-3 mb-6">
                            <Clock className="w-5 h-5 text-brand" />
                            <h2 className="text-xl font-semibold text-white">Coming Soon</h2>
                            <span className="text-[var(--text-muted)] text-sm">({data.upcoming.length})</span>
                        </div>

                        <div className="grid-media">
                            {data.upcoming.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {data?.recent && data.recent.length > 0 && (
                    <section>
                        <div className="flex items-center gap-3 mb-6">
                            <Disc className="w-5 h-5 text-success" />
                            <h2 className="text-xl font-semibold text-white">Just Dropped</h2>
                            <span className="text-[var(--text-muted)] text-sm">({data.recent.length})</span>
                        </div>

                        <div className="grid-media">
                            {data.recent.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {(!data?.upcoming?.length && !data?.recent?.length) && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <Calendar className="w-16 h-16 text-[var(--text-muted)] mb-6" />
                        <h3 className="text-xl font-medium text-white mb-2">No releases found</h3>
                        <p className="text-[var(--text-secondary)] max-w-md mb-6">
                            Add artists to Lidarr and enable monitoring to see their upcoming and recent releases here.
                        </p>
                        <Link
                            href="/settings"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-brand text-black rounded-lg hover:bg-brand-hover transition-colors"
                        >
                            Configure Lidarr
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Cover art for one release, or a placeholder. Art loads through this app's
 * image endpoint, so a cover that disappears fails on our origin and falls
 * back to the placeholder instead of a broken box.
 */
function ReleaseCover({ release }: { release: ReleaseItem }) {
    const [broken, setBroken] = useState(false);

    const src = useMemo(
        () => (release.coverUrl ? api.getCoverArtUrl(release.coverUrl, 500) : null),
        [release.coverUrl],
    );

    if (!src || broken) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <Disc className="w-12 h-12 text-[var(--text-muted)]" />
            </div>
        );
    }

    return (
        <CachedImage
            src={src}
            alt={release.title}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
            className="object-cover cover-zoom"
            onError={() => setBroken(true)}
        />
    );
}

function ReleaseCard({
    release,
    formatDate,
    onDownload,
    isDownloading,
}: {
    release: ReleaseItem;
    formatDate: (date: string) => string;
    onDownload: (albumMbid: string, releaseId: string | number) => void;
    isDownloading: boolean;
}) {
    const isUpcoming = release.status === 'upcoming';
    const hasIt = release.inLibrary;

    return (
        <div className="group relative">
            <div className="aspect-square rounded-lg overflow-hidden bg-white/5 mb-3 relative">
                <ReleaseCover release={release} />

                <div className={cn(
                    "absolute top-2 left-2 px-2 py-1 rounded text-xs font-medium",
                    isUpcoming ? "bg-brand text-black" :
                    hasIt ? "bg-success/90 text-black" : "bg-white/20 text-white"
                )}>
                    {isUpcoming ? formatDate(release.releaseDate) :
                     hasIt ? "In Library" : "Available"}
                </div>

                {release.canDownload && !hasIt && (
                    <button
                        onClick={() => onDownload(release.albumMbid, release.id)}
                        disabled={isDownloading}
                        className={cn(
                            "absolute inset-0 flex items-center justify-center",
                            "bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity",
                            isDownloading && "opacity-100"
                        )}
                    >
                        {isDownloading ? (
                            <Loader2 className="w-8 h-8 text-white animate-spin" />
                        ) : (
                            <Download className="w-8 h-8 text-white" />
                        )}
                    </button>
                )}

                {hasIt && (
                    <div className="absolute bottom-2 right-2">
                        <CheckCircle2 className="w-5 h-5 text-success" />
                    </div>
                )}
            </div>

            <div className="space-y-1">
                <h3 className="text-sm font-medium text-white truncate" title={release.title}>
                    {release.title}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] truncate" title={release.artistName}>
                    {release.artistName}
                </p>
                {isUpcoming && (
                    <p className="text-xs text-[var(--text-secondary)]">
                        {new Date(release.releaseDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                        })}
                    </p>
                )}
            </div>
        </div>
    );
}



