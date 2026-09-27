import {
  matchTrackToLibrary,
  type MatchCandidate,
  type SourceTrack,
} from "../trackMatching";

const candidate = (
  id: string,
  title: string,
  artistName: string,
  albumTitle = "Album",
): MatchCandidate => ({ id, title, albumId: `al-${id}`, albumTitle, artistName });

describe("matchTrackToLibrary", () => {
  it("matches exact title with agreeing album at confidence 100", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "WANDERLAND",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "Wanderland"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(100);
    expect(result?.candidate.id).toBe("t1");
  });

  it("matches exact title when the source has no album hint at 90", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "Unknown Album",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "Wanderland"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(90);
  });

  it("matches exact title on a DIFFERENT album only at 85 (probable)", () => {
    const source: SourceTrack = {
      title: "Home",
      artist: "Depapepe",
      album: "WANDERLAND",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Home", "DEPAPEPE", "OTHER ALBUM"),
    ]);
    expect(result?.matchType).toBe("exact");
    expect(result?.confidence).toBe(85);
  });

  it("matches suffix-stripped titles (\"Song (Remastered)\" vs \"Song\")", () => {
    const source: SourceTrack = {
      title: "Horse With No Name (Remastered)",
      artist: "America",
      album: "History",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Horse With No Name", "America", "History"),
    ]);
    expect(result?.matchType).toBe("exact");
  });

  it("matches containment: \"Sordid Affair\" vs \"Sordid Affair (Feat. Ryan James)\"", () => {
    const source: SourceTrack = {
      title: "Sordid Affair",
      artist: "Comatose White",
      album: "Self-Titled",
    };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "Sordid Affair (Feat. Ryan James)", "Comatose White"),
    ]);
    expect(result?.matchType).toBe("fuzzy");
    expect(result?.confidence).toBeGreaterThanOrEqual(80);
  });

  it("does not match when no candidate shares the title", () => {
    const source: SourceTrack = {
      title: "Nonexistent Track",
      artist: "Some Artist",
      album: "Some Album",
    };
    expect(
      matchTrackToLibrary(source, [candidate("t1", "A Totally Different Song", "Some Artist")]),
    ).toBeNull();
  });

  it("does not match an empty pool", () => {
    expect(
      matchTrackToLibrary({ title: "Any", artist: "Any" }, []),
    ).toBeNull();
  });

  it("title-only mode accepts a same-title candidate from another artist", () => {
    const source: SourceTrack = { title: "Song Of The Year", artist: "Keane" };
    const result = matchTrackToLibrary(
      source,
      [candidate("t1", "Song Of The Year", "Not Keane")],
      { requireArtistMatch: false },
    );
    // Exact title wins regardless of artist when the caller opts out of the
    // artist gate — that is the compilation/Various-Artists fallback.
    expect(result?.candidate.id).toBe("t1");
  });

  it("keeps artist gating on by default and does not jump to unrelated artists", () => {
    const source: SourceTrack = { title: "96 Proof Of Love", artist: "Kari Faux" };
    const result = matchTrackToLibrary(source, [
      candidate("t1", "96 Proof Of Love (Alternate)", "Kari Faux"),
    ]);
    expect(result?.candidate.id).toBe("t1");
    expect(result?.matchType).toBe("fuzzy");
  });
});