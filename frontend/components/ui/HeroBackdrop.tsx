import Image from "next/image";
import type { ColorPalette } from "@/hooks/useImageColor";

const TINTS = {
    music: {
        imageClass: "opacity-50",
        overImage: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}30 0%, ${c.darkVibrant}60 40%, ${c.darkMuted}90 70%, #0a0a0a 100%)`,
        bare: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}40 0%, ${c.darkVibrant}80 50%, #0a0a0a 100%)`,
    },
    spoken: {
        imageClass: "opacity-40",
        overImage: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}20 0%, ${c.darkVibrant}50 40%, #0a0a0a 100%)`,
        bare: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}30 0%, ${c.darkVibrant}60 50%, #0a0a0a 100%)`,
    },
} as const;

interface HeroBackdropProps {
    image: string | null | undefined;
    alt: string;
    colors: ColorPalette | null;
    tint: keyof typeof TINTS;
    /** Top and middle stops used when there is neither an image nor a palette. */
    fallback: [string, string];
}

/** The blurred artwork and palette gradient behind a detail page's hero. */
export function HeroBackdrop({ image, alt, colors, tint, fallback }: HeroBackdropProps) {
    const t = TINTS[tint];

    if (!image) {
        return (
            <div
                className="absolute inset-0"
                style={{
                    background: colors
                        ? t.bare(colors)
                        : `linear-gradient(to bottom, ${fallback[0]} 0%, ${fallback[1]} 50%, #0a0a0a 100%)`,
                }}
            />
        );
    }

    return (
        <div className="absolute inset-0 overflow-hidden">
            <div className={`absolute inset-0 scale-110 blur-md ${t.imageClass}`}>
                <Image
                    src={image}
                    alt={alt}
                    fill
                    sizes="100vw"
                    className="object-cover"
                    priority
                    unoptimized
                />
            </div>
            <div
                className="absolute inset-0"
                style={{
                    background: colors
                        ? t.overImage(colors)
                        : "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 40%, #0a0a0a 100%)",
                }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-transparent to-transparent" />
        </div>
    );
}
