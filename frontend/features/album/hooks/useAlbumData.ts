import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import type { AlbumSource } from "../types";
import { useMemo } from "react";

export function useAlbumData(albumId?: string) {
    const params = useParams();
    const id = albumId || (params.id as string);

    const {
        data: album,
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: queryKeys.album(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");
            try {
                return await api.getAlbum(id);
            } catch {
                return await api.getAlbumDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    const source: AlbumSource | null = useMemo(() => {
        if (!album) return null;
        return album.owned === true ? "library" : "discovery";
    }, [album]);

    return {
        album,
        loading: isLoading,
        notFound: (error as { status?: number } | null)?.status === 404,
        failed: !!error,
        source,
        reloadAlbum: refetch,
    };
}
