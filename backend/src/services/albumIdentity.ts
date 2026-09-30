/**
 * Album identity, the sibling of artistIdentity. An Album is a MusicBrainz
 * release group, and only true duplicates merge: "Il Pozzo D'Amor" and "Il
 * Pozzo d'Amor" merge; "Playing the Angel (Deluxe)" stays separate. The
 * `temp-` rgMbid placeholder stays until OwnedAlbum and DiscoveryAlbum reference
 * albums by id, since they key on the rgMbid string today.
 */

import { Prisma } from "@prisma/client";
import { foldIdentityText, artistSortName } from "./artistIdentity";
import { pgCollapseSpace, pgLower, pgTrim, stripNonAlnum } from "./pgTextRules";
import { LIBRARY_LOCATION } from "./libraryFilters";

/**
 * Titles too generic to identify a release group on their own. A cross-artist
 * match on any of these is almost certainly two different albums that happen to
 * share a name.
 */
const GENERIC_TITLES = new Set([
    "unknown album",
    "unknown",
    "untitled",
    "greatest hits",
    "the greatest hits",
    "best of",
    "the best of",
    "hits",
    "singles",
    "demos",
    "live",
    "ep",
    "compilation",
    "various",
    "self titled",
    "s/t",
]);

/**
 * The album's dedupe key within its artist: case, punctuation, accents and
 * unicode variants fold; edition markers stay. "Il Pozzo D'Amor" -> "ilpozzodamor",
 * "Playing the Angel (Deluxe)" -> "playingtheangel(deluxe)".
 */
export function albumIdentityKey(title: string | null | undefined): string {
    if (title == null) return "";
    return stripNonAlnum(pgLower(foldIdentityText(pgTrim(String(title)))));
}

/**
 * Is this title too generic to be matched across artists?
 *
 * Compared on the casefolded form so "The Best Of" is caught alongside
 * "best of". Edition markers are kept so "Best Of (Deluxe)" and "Best Of"
 * are treated as distinct titles.
 */
export function isGenericAlbumTitle(title: string | null | undefined): boolean {
    if (title == null) return true;
    const normalised = pgTrim(
        pgCollapseSpace(pgLower(foldIdentityText(pgTrim(String(title)))))
    );
    // Emptiness is judged on the identity key, not on this spacing-preserving
    // form: "( )" is non-empty here but collapses to "" as a key, and a title
    // with no identity is exactly the case that must not match across artists.
    return (
        normalised === "" ||
        albumIdentityKey(title) === "" ||
        GENERIC_TITLES.has(normalised)
    );
}

export interface ResolveAlbumInput {
    artistId: string;
    title: string;
    /** MusicBrainz release-group id, when the source supplied one. */
    rgMbid?: string | null;
    year?: number | null;
    /**
     * True when the tags say this is a compilation. Only then may an album be
     * shared across artists -- that is the case the cross-artist fallback was
     * written for, and the only one where it is safe.
     */
    isCompilation?: boolean;
    /**
     * Extra fields for a NEW row. A function is accepted so a caller whose
     * create-only work is expensive -- the scanner runs several queries to
     * decide DISCOVER vs LIBRARY -- does not pay for it on a lookup hit.
     */
    createData?:
        | Omit<Prisma.AlbumUncheckedCreateInput, "artistId" | "title" | "rgMbid" | "identityKey">
        | (() => Promise<
              Omit<Prisma.AlbumUncheckedCreateInput, "artistId" | "title" | "rgMbid" | "identityKey">
          >);
}

type AlbumClient = Pick<Prisma.TransactionClient, "album">;

/**
 * The ONLY place an album row is looked up or created.
 *
 * Order: release-group id first (authoritative), then the identity key scoped
 * to the artist, then -- for compilations only -- a cross-artist match.
 */
export async function resolveAlbum(
    db: AlbumClient,
    input: ResolveAlbumInput
) {
    const title = String(input.title ?? "").trim() || "Unknown Album";
    // Sentinel retained until OwnedAlbum/DiscoveryAlbum stop keying on this
    // string value -- see the scope note at the top of this file.
    const rgMbid =
        input.rgMbid?.trim() || `temp-${Date.now()}-${Math.random()}`;
    const identityKey = albumIdentityKey(title) || `untitled-${input.artistId}`;

    if (rgMbid) {
        const byMbid = await db.album.findUnique({ where: { rgMbid } });
        if (byMbid) return byMbid;
    }

    const existing = await db.album.findUnique({
        where: {
            artistId_identityKey: { artistId: input.artistId, identityKey },
        },
    });
    if (existing) {
        if (input.rgMbid?.trim() && existing.rgMbid.startsWith("temp-")) {
            try {
                return await db.album.update({
                    where: { id: existing.id },
                    data: { rgMbid: input.rgMbid!.trim() },
                });
            } catch (error: any) {
                if (error?.code !== "P2002") throw error;
            }
        }
        return existing;
    }

    // Cross-artist reuse for compilations only, keeping a VA release together
    // when its files' albumartist tags disagree.
    if (
        input.isCompilation &&
        input.year != null &&
        !isGenericAlbumTitle(title)
    ) {
        const shared = await db.album.findFirst({
            where: { identityKey, year: input.year, location: LIBRARY_LOCATION },
        });
        if (shared) return shared;
    }

    const extra =
        typeof input.createData === "function"
            ? await input.createData()
            : input.createData;

    try {
        return await db.album.create({
            data: {
                ...(extra as any),
                artistId: input.artistId,
                title,
                identityKey,
                // The canonical title; a later display override updates sortName itself.
                sortName: artistSortName(title),
                rgMbid,
                year: input.year ?? null,
            },
        });
    } catch (error: any) {
        if (error?.code === "P2002") {
            const raced =
                (await db.album.findUnique({
                    where: {
                        artistId_identityKey: {
                            artistId: input.artistId,
                            identityKey,
                        },
                    },
                })) ??
                (rgMbid ? await db.album.findUnique({ where: { rgMbid } }) : null);
            if (raced) return raced;
        }
        throw error;
    }
}
