/**
 * addTracks accepts any real track, including ones on DISCOVER albums. Real
 * database, since the rule lives in a Prisma where-clause.
 */

import { prisma } from "../../utils/db";
import { addTracks } from "../playlistService";
import { createTrackChain, deleteFixtures } from "./helpers/trackChainFixture";

const PREFIX = "pl-addtracks-test";

function cleanup() {
    return deleteFixtures(PREFIX);
}

async function fixture(location: "LIBRARY" | "DISCOVER") {
    const { tag, track, user } = await createTrackChain(PREFIX, location, { location });
    const playlist = await prisma.playlist.create({
        data: { userId: user.id, name: `${PREFIX}-${tag}-pl` },
    });
    return { track, playlist };
}

describe("playlistService.addTracks across album locations", () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it("adds a track from a DISCOVER album", async () => {
        const { track, playlist } = await fixture("DISCOVER");

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toMatchObject({ added: 1, duplicates: 0, rejected: [] });
        const rows = await prisma.playlistItem.findMany({
            where: { playlistId: playlist.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].trackId).toBe(track.id);
        expect(rows[0].rank).toBeTruthy();
    });

    it("adds a track from a LIBRARY album", async () => {
        const { track, playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toMatchObject({ added: 1, duplicates: 0, rejected: [] });
    });

    it("rejects only ids that match no track at all", async () => {
        const { playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, ["nonexistent-track-id"]);

        expect(result).toMatchObject({
            added: 0,
            duplicates: 0,
            rejected: ["nonexistent-track-id"],
        });
    });
});
