/**
 * Discover and playlist import name the artist from the album's own MusicBrainz
 * credit; the fuzzy name correction runs only for albums with no id.
 */

const mockGetReleaseGroup = jest.fn();
const mockGetArtistCorrection = jest.fn();

jest.mock("../musicbrainz", () => ({
    musicBrainzService: { getReleaseGroup: (...a: unknown[]) => mockGetReleaseGroup(...a) },
}));
jest.mock("../artistCorrection", () => ({
    getArtistCorrection: (...a: unknown[]) => mockGetArtistCorrection(...a),
}));
jest.mock("../soulseek", () => ({ soulseekService: {} }));
jest.mock("../simpleDownloadManager", () => ({ simpleDownloadManager: {} }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { acquisitionService } from "../acquisitionService";

const RG = "11111111-2222-3333-4444-555555555555";
const name = (request: { albumTitle: string; artistName: string; mbid?: string }) =>
    (acquisitionService as any).canonicalArtistName(request);

beforeEach(() => jest.clearAllMocks());

it("keeps the given name when MusicBrainz is unreachable", async () => {
    mockGetReleaseGroup.mockResolvedValue({ kind: "transient", error: { code: "ETIMEDOUT", message: "timed out" }, evidence: {} });

    expect(await name({ albumTitle: "Antics", artistName: "interpol", mbid: RG })).toBe("interpol");
    expect(mockGetArtistCorrection).not.toHaveBeenCalled();
});

it("never guesses from the name when the album has an id", async () => {
    mockGetReleaseGroup.mockResolvedValue({ kind: "absent", evidence: {} });

    await name({ albumTitle: "Antics", artistName: "Interpol", mbid: RG });

    expect(mockGetArtistCorrection).not.toHaveBeenCalled();
});

it("corrects the name only for an album with no id", async () => {
    mockGetArtistCorrection.mockResolvedValue({ corrected: true, canonicalName: "Of Mice & Men" });

    expect(await name({ albumTitle: "Restoring Force", artistName: "of mice" })).toBe("Of Mice & Men");
    expect(mockGetReleaseGroup).not.toHaveBeenCalled();
});

it("takes the artist the album's release group credits", async () => {
    mockGetReleaseGroup.mockResolvedValue({
        kind: "answered",
        value: { "artist-credit": [{ artist: { name: "Interpol" } }] },
        evidence: {},
    });

    expect(await name({ albumTitle: "Antics", artistName: "interpol & friends", mbid: RG })).toBe("Interpol");
    expect(mockGetReleaseGroup).toHaveBeenCalledWith(RG);
});
