"use client";

import Image, { ImageProps } from "next/image";
import { memo } from "react";

interface CachedImageProps extends Omit<ImageProps, "src"> {
    src: string | null | undefined;
    fill?: boolean;
}

/* Cover art is served cache-first by the service worker for /api/library/cover-art/*. */
const CachedImage = memo(function CachedImage({
    src,
    alt = "",
    ...props
}: CachedImageProps) {
    if (!src) {
        return null;
    }

    const imageProps = {
        ...props,
        loading: props.loading || 'lazy',
    };

    return <Image src={src} alt={alt} unoptimized {...imageProps} />;
});

export { CachedImage };
export type { CachedImageProps };
