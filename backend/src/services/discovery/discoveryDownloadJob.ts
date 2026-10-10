import type { Prisma } from '@prisma/client';

interface DiscoveryJobAlbum {
    artistName: string;
    artistMbid?: string | null;
    albumTitle: string;
    albumMbid: string;
    tier?: string;
}

export interface DiscoveryDownloadJobInput {
    userId: string;
    batchId: string;
    musicPath: string;
    album: DiscoveryJobAlbum;
    similarity: number;
    extraMetadata?: Prisma.InputJsonObject;
}

export function createDiscoveryDownloadJob(
    tx: Prisma.TransactionClient,
    { userId, batchId, musicPath, album, similarity, extraMetadata }: DiscoveryDownloadJobInput
) {
    return tx.downloadJob.create({
        data: {
            userId,
            subject: `${album.artistName} - ${album.albumTitle}`,
            type: 'album',
            targetMbid: album.albumMbid,
            status: 'pending',
            discoveryBatchId: batchId,
            artistMbid: album.artistMbid,
            metadata: {
                downloadType: 'discovery',
                rootFolderPath: musicPath,
                artistName: album.artistName,
                artistMbid: album.artistMbid,
                albumTitle: album.albumTitle,
                albumMbid: album.albumMbid,
                similarity,
                tier: album.tier,
                ...extraMetadata,
            },
        },
    });
}
