/**
 * artistIdentityKey must match the artist_identity migration's SQL backfill,
 * since identityKey is unique and resolveArtist looks artists up by it. "&"
 * becomes "and" on both sides. Expectations come from running the migration's
 * UPDATE on Postgres 16.
 */

import { artistIdentityKey } from "../artistIdentity";

describe("artistIdentityKey agrees with the migration backfill", () => {
    it.each([
        ["AC&DC", "acanddc"],
        ["Simon & Garfunkel", "simonandgarfunkel"],
        ["Earth, Wind & Fire", "earthwindandfire"],
        ["Hall & Oates", "hallandoates"],
    ])("folds the ampersand in %s", (name, expected) => {
        expect(artistIdentityKey(name)).toBe(expected);
    });

    it.each([
        ["Björk", "bjork"],
        ["MØ", "mo"],
        ["Kælan Mikla", "kaelanmikla"],
        ["東京事変", "東京事変"],
        ["deadmau5", "deadmau5"],
    ])("matches unaccent() on %s", (name, expected) => {
        expect(artistIdentityKey(name)).toBe(expected);
    });
});
