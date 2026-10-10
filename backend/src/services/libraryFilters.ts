/**
 * Library-scope filters. DISCOVER albums are suggestions, not owned, so a query
 * limited to owned content spreads one of these into its `where`.
 */

import { Prisma } from "@prisma/client";

/** `Album.location` for owned albums. */
export const LIBRARY_LOCATION = "LIBRARY";

/** Spread into an `Album` where-clause to scope it to owned-library albums. */
export const LIBRARY_ALBUM_WHERE: Prisma.AlbumWhereInput = {
    location: LIBRARY_LOCATION,
};

/** Spread into a `Track` where-clause (via the album relation) to scope it to owned-library tracks. */
export const LIBRARY_TRACK_WHERE: Prisma.TrackWhereInput = {
    album: { location: LIBRARY_LOCATION },
};
