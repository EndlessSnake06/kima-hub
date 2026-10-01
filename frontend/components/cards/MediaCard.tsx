import { memo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { Play, Trash2, type LucideIcon } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";

export type MediaType = "artist" | "album" | "track" | "podcast" | "audiobook";

const TYPE_STYLES: Record<MediaType, { border: string; bar: string }> = {
    artist: { border: "hover:border-type-artist/50", bar: "bg-type-artist" },
    album: { border: "hover:border-type-album/50", bar: "bg-type-album" },
    track: { border: "hover:border-type-track/50", bar: "bg-type-track" },
    podcast: { border: "hover:border-type-podcast/50", bar: "bg-type-podcast" },
    audiobook: { border: "hover:border-type-audiobook/50", bar: "bg-type-audiobook" },
};

interface MediaCardProps {
    href: string;
    title: string;
    subtitle?: string;
    imageUrl: string | null;
    fallbackIcon: LucideIcon;
    type: MediaType;
    index?: number;
    sizes?: string;
    badge?: ReactNode;
    onPlay?: () => void;
    onDelete?: () => void;
    className?: string;
    imageClassName?: string;
}

function stop(handler: () => void) {
    return (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
    };
}

export const MediaCard = memo(function MediaCard({
    href,
    title,
    subtitle,
    imageUrl,
    fallbackIcon: FallbackIcon,
    type,
    index = 0,
    sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw",
    badge,
    onPlay,
    onDelete,
    className,
    imageClassName,
}: MediaCardProps) {
    const styles = TYPE_STYLES[type];

    return (
        <Link
            href={href}
            data-tv-card
            data-tv-card-index={index}
            style={{ "--i": index } as CSSProperties}
            className={cn(
                "group block animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                className,
            )}
        >
            <div
                className={cn(
                    "relative bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden transition-[border-color] duration-150",
                    styles.border,
                )}
            >
                <div className="relative aspect-square">
                    <div
                        className={cn(
                            "relative w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden",
                            imageClassName,
                        )}
                    >
                        {imageUrl ? (
                            <CachedImage
                                src={imageUrl}
                                alt={title}
                                fill
                                sizes={sizes}
                                className="object-cover group-hover:scale-110 transition-transform duration-150"
                            />
                        ) : (
                            <FallbackIcon className="w-10 h-10 text-[var(--text-muted)]" />
                        )}
                    </div>

                    {badge && <div className="absolute top-2 left-2">{badge}</div>}

                    {onPlay && (
                        <>
                            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                            <button
                                type="button"
                                onClick={stop(onPlay)}
                                aria-label={`Play ${title}`}
                                className="touch-reveal absolute bottom-3 right-3 w-11 h-11 rounded-lg bg-brand hover:bg-brand-hover flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
                            >
                                <Play className="w-5 h-5 fill-current ml-0.5 text-black" />
                            </button>
                        </>
                    )}

                    {onDelete && (
                        <button
                            type="button"
                            onClick={stop(onDelete)}
                            aria-label={`Delete ${title}`}
                            title={`Delete ${title}`}
                            className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/80 border border-white/20 hidden md:flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-danger/90 transition-opacity duration-150"
                        >
                            <Trash2 className="w-4 h-4 text-white" />
                        </button>
                    )}
                </div>

                <div className={cn("h-0.5 scale-x-0 group-hover:scale-x-100 transition-transform duration-150", styles.bar)} />

                <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                    <h3 className="text-sm font-bold text-white truncate tracking-tight">{title}</h3>
                    {subtitle && (
                        <p className="text-xs tabular-nums text-[var(--text-muted)] truncate mt-0.5">{subtitle}</p>
                    )}
                </div>
            </div>
        </Link>
    );
});
