"use client";

import { memo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, Trash2, type LucideIcon } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";

type MediaType = "artist" | "album" | "track" | "podcast" | "audiobook";

const TYPE_STYLES: Record<MediaType, { border: string; bar: string }> = {
    artist: { border: "hover:border-type-artist/50", bar: "bg-type-artist" },
    album: { border: "hover:border-type-album/50", bar: "bg-type-album" },
    track: { border: "hover:border-type-track/50", bar: "bg-type-track" },
    podcast: { border: "hover:border-type-podcast/50", bar: "bg-type-podcast" },
    audiobook: { border: "hover:border-type-audiobook/50", bar: "bg-type-audiobook" },
};

interface MediaCardAction {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
    busy?: boolean;
}

interface MediaCardProps {
    href?: string;
    title: string;
    subtitle?: ReactNode;
    imageUrl?: string | string[] | null;
    fallbackIcon: LucideIcon;
    type: MediaType;
    aspect?: "square" | "portrait";
    index?: number;
    sizes?: string;
    badge?: ReactNode;
    corner?: ReactNode;
    progress?: number;
    action?: MediaCardAction;
    onDelete?: () => void;
    className?: string;
}

function stop(handler: () => void) {
    return (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
    };
}

function Cover({
    imageUrl,
    title,
    sizes,
    FallbackIcon,
}: {
    imageUrl?: string | string[] | null;
    title: string;
    sizes: string;
    FallbackIcon: LucideIcon;
}) {
    const [broken, setBroken] = useState(false);
    const urls = (Array.isArray(imageUrl) ? imageUrl : [imageUrl]).filter(
        (url): url is string => !!url,
    );

    if (urls.length === 0 || broken) {
        return <FallbackIcon className="w-10 h-10 text-[var(--text-muted)]" />;
    }

    if (urls.length === 1) {
        return (
            <CachedImage
                src={urls[0]}
                alt={title}
                fill
                sizes={sizes}
                className="object-cover cover-zoom"
                onError={() => setBroken(true)}
            />
        );
    }

    return (
        <div className="grid grid-cols-2 w-full h-full cover-zoom">
            {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="relative flex items-center justify-center">
                    {urls[i] ? (
                        <CachedImage src={urls[i]} alt="" fill sizes="100px" className="object-cover" />
                    ) : (
                        <FallbackIcon className="w-6 h-6 text-[var(--text-muted)]" />
                    )}
                </div>
            ))}
        </div>
    );
}

export const MediaCard = memo(function MediaCard({
    href,
    title,
    subtitle,
    imageUrl,
    fallbackIcon,
    type,
    aspect = "square",
    index = 0,
    sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw",
    badge,
    corner,
    progress,
    action,
    onDelete,
    className,
}: MediaCardProps) {
    const styles = TYPE_STYLES[type];
    const ActionIcon = action?.busy ? Loader2 : action?.icon;

    const body = (
        <div
            className={cn(
                "relative bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden transition-[border-color] duration-150",
                styles.border,
            )}
        >
            <div className={cn("relative", aspect === "portrait" ? "aspect-[2/3]" : "aspect-square")}>
                <div className="relative w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                    <Cover key={String(imageUrl)} imageUrl={imageUrl} title={title} sizes={sizes} FallbackIcon={fallbackIcon} />
                </div>

                {badge && <div className="absolute top-2 left-2">{badge}</div>}
                {corner && <div className="absolute top-2 right-2">{corner}</div>}

                {progress !== undefined && progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                        <div className="h-full bg-brand" style={{ width: `${Math.min(progress, 100)}%` }} />
                    </div>
                )}

                {action && ActionIcon && (
                    <>
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />
                        <button
                            type="button"
                            onClick={stop(action.onClick)}
                            disabled={action.busy}
                            aria-label={`${action.label} ${title}`}
                            title={action.label}
                            className={cn(
                                "touch-reveal absolute bottom-3 right-3 w-11 h-11 rounded-lg bg-brand hover:bg-brand-hover flex items-center justify-center transition-opacity duration-150",
                                action.busy ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                        >
                            <ActionIcon
                                className={cn("w-5 h-5 text-black", action.busy ? "animate-spin" : "fill-current ml-0.5")}
                            />
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
                <h3 className="text-sm font-bold text-white truncate tracking-tight" title={title}>
                    {title}
                </h3>
                {subtitle && (
                    <p className="text-xs tabular-nums text-[var(--text-muted)] truncate mt-0.5">{subtitle}</p>
                )}
            </div>
        </div>
    );

    const rootProps = {
        "data-tv-card": true,
        "data-tv-card-index": index,
        style: { "--i": index } as CSSProperties,
        className: cn("group block animate-rise [animation-delay:calc(var(--i)*var(--stagger))]", className),
    };

    return href ? (
        <Link href={href} {...rootProps}>
            {body}
        </Link>
    ) : (
        <div tabIndex={0} {...rootProps}>
            {body}
        </div>
    );
});
