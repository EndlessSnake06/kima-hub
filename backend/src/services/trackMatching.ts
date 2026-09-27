/**
 * Track matching — ONE implementation, used by the import preview
 * (`matchTrack`), the build path (`buildPlaylist`), and the reconcile sweep
 * (`reconcilePendingTracks`).
 *
 * Before this module each path carried its own copy of the matching ladder
 * with its own thresholds, and they had drifted: the same pending track
 * could match to different local tracks depending on which path ran. The
 * ladder below is `buildPlaylist`'s (the other two claimed parity with it),
 * and the thresholds live only here.
 *
 * The function is PURE: callers supply the candidate pool (a preloaded
 * per-artist-word bucket, a per-record DB query, or a title-contains sweep)
 * and get back a verdict. Candidate sourcing is genuinely per-caller — that
 * is a data-access decision, not a matching decision — but the decision of
 * "does candidate C match source S, and with what confidence" exists once.
 *
 * ISRC identity is deliberately NOT handled here: it is an exact lookup, not
 * a fuzzy decision, and each caller already holds an ISRC-keyed map built
 * from its own query. Same semantics, cache not ladder.
 */

import {
  normalizeApostrophes,
  stripTrackSuffix,
  normalizeTrackTitle,
  normalizeAlbumForMatching,
  stringSimilarity,
} from "../utils/normalization";
import { normalizeArtistName } from "../utils/artistNormalization";
import { parseCredit } from "./artistIdentity";

/** The record being searched for (a Spotify track, or its stored pending row). */
export interface SourceTrack {
  title: string;
  /** Full credit string, e.g. "Artist feat. Someone". */
  artist: string;
  /** Album title; "Unknown Album" or missing means no album hint. */
  album?: string;
}

/** A library track a source could match. Only matching-relevant fields. */
export interface MatchCandidate {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistName: string;
}

export interface MatchResult {
  candidate: MatchCandidate;
  matchType: "exact" | "fuzzy";
  /** 0-100. */
  confidence: number;
}

/**
 * One source track against one candidate pool. First strategy that hits
 * wins; the ladder order is the contract.
 *
 * `requireArtistMatch` (default true) gates the strict strategies (exact
 * title, containment, prefix): candidates from a different artist are
 * ignored for them. With it false, a same-title candidate from ANY artist
 * can match — that is the title-only fallback, and its floor is an exact
 * title or ≥85 similarity. The scoring strategies (the 60/40 and 70/30
 * title/artist blends) always scan the whole pool, because historically the
 * candidate queries keyed on the artist's FIRST WORD and deliberately
 * admitted artists sharing that first word.
 */
export function matchTrackToLibrary(
  source: SourceTrack,
  candidates: MatchCandidate[],
  opts: { requireArtistMatch?: boolean } = {},
): MatchResult | null {
  if (candidates.length === 0) return null;

  const requireArtistMatch = opts.requireArtistMatch !== false;
  const primaryArtist = parseCredit(source.artist).primary || source.artist;
  const normPrimary = normalizeArtistName(primaryArtist);
  const normFull = normalizeArtistName(source.artist);
  const artistMatches = (c: MatchCandidate): boolean => {
    const key = normalizeArtistName(c.artistName);
    return key === normPrimary || key === normFull;
  };
  const strictPool = requireArtistMatch
    ? candidates.filter(artistMatches)
    : candidates;

  // Precompute the source's title forms once.
  const strippedTitle = stripTrackSuffix(source.title);
  const cleanedTitle = normalizeTrackTitle(source.title);
  const rawTitleLower = normalizeApostrophes(source.title).toLowerCase();
  const sameTitle = (c: MatchCandidate): boolean =>
    normalizeApostrophes(c.title).toLowerCase() === rawTitleLower ||
    normalizeTrackTitle(c.title) === cleanedTitle ||
    normalizeTrackTitle(c.title) === stripTrackSuffix(source.title).toLowerCase();

  const albumUnknown = !source.album || source.album === "Unknown Album";
  const sourceAlbum = normalizeAlbumForMatching(source.album ?? "").toLowerCase();
  const albumAgrees = (c: MatchCandidate): boolean => {
    if (albumUnknown) return true;
    const dbAlbum = normalizeAlbumForMatching(c.albumTitle).toLowerCase();
    return (
      dbAlbum === sourceAlbum ||
      dbAlbum.includes(sourceAlbum) ||
      sourceAlbum.includes(dbAlbum)
    );
  };

  // 1. Exact title (raw or suffix-stripped). Album decides 100 vs 85:
  //    an album-having source matched on an album-disagreeing candidate is
  //    still an exact title hit, but only "probable".
  let titleWithoutAlbumAgreement: MatchCandidate | null = null;
  for (const c of strictPool) {
    if (!sameTitle(c)) continue;
    if (albumAgrees(c)) {
      return {
        candidate: c,
        matchType: "exact",
        confidence: albumUnknown ? 90 : 100,
      };
    }
    if (!titleWithoutAlbumAgreement) titleWithoutAlbumAgreement = c;
  }
  if (titleWithoutAlbumAgreement) {
    return {
      candidate: titleWithoutAlbumAgreement,
      matchType: "exact",
      confidence: 85,
    };
  }

  // 2. Normalized containment: "Sordid Affair" matches
  //    "Sordid Affair (Feat. Ryan James)". Confidence is the measured
  //    similarity, floored at 80 because containment is strong evidence.
  for (const c of strictPool) {
    const cNorm = normalizeTrackTitle(c.title).toLowerCase();
    if (cNorm === cleanedTitle) continue; // strategy 1 owns the equal case
    if (cNorm.startsWith(cleanedTitle) || cleanedTitle.startsWith(cNorm)) {
      return {
        candidate: c,
        matchType: "fuzzy",
        confidence: Math.max(
          stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)),
          80,
        ),
      };
    }
  }

  // 3. First-four-words containment plus a similarity floor. Catches
  //    candidates whose extra words sit BEFORE the shared stem
  //    ("The Song" vs "Original Song Version") only when they still share
  //    ≥80 similarity.
  if (strippedTitle.length >= 5) {
    const searchTerm = strippedTitle.split(" ").slice(0, 4).join(" ").toLowerCase();
    for (const c of strictPool) {
      if (!c.title.toLowerCase().includes(searchTerm)) continue;
      const sim = stringSimilarity(
        cleanedTitle,
        normalizeTrackTitle(c.title),
      );
      if (sim >= 80) {
        return { candidate: c, matchType: "fuzzy", confidence: sim };
      }
    }
  }

  // 4. Weighted fuzzy (title 60 / artist 40) over the WHOLE pool: this is
  //    where an artist sharing only the first word can still match.
  for (const c of candidates) {
    const score =
      stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)) * 0.6 +
      stringSimilarity(normalizeArtistName(source.artist), normalizeArtistName(c.artistName)) * 0.4;
    if (score >= 70) {
      return { candidate: c, matchType: "fuzzy", confidence: Math.round(score) };
    }
  }

  // 5. Prefix containment: same first ≥10 words-of-title, ≥70 similarity.
  if (strippedTitle.length > 10) {
    const prefix = strippedTitle.substring(0, Math.min(20, strippedTitle.length)).toLowerCase();
    for (const c of strictPool) {
      if (!c.title.toLowerCase().startsWith(prefix)) continue;
      const sim = stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title));
      if (sim >= 70) {
        return { candidate: c, matchType: "fuzzy", confidence: sim };
      }
    }
  }

  // 6. Last-resort weighted fuzzy (title 70 / artist 30) ≥65 over the pool.
  let best: MatchCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score =
      stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title)) * 0.7 +
      stringSimilarity(normalizeArtistName(source.artist), normalizeArtistName(c.artistName)) * 0.3;
    if (score > bestScore && score >= 65) {
      bestScore = score;
      best = c;
    }
  }
  if (best) {
    return { candidate: best, matchType: "fuzzy", confidence: Math.round(bestScore) };
  }

  // 7. Title-only fallback (title-contains mode only): a candidate from ANY
  //    artist whose normalized title is ≥85 similar. This is what the
  //    title-only batch search exists for; in artist-gated mode it must not
  //    fire, or a wrong artist wins.
  if (!requireArtistMatch) {
    let titleBest: MatchCandidate | null = null;
    let titleBestScore = 0;
    for (const c of candidates) {
      const sim = stringSimilarity(cleanedTitle, normalizeTrackTitle(c.title));
      if (sim > titleBestScore && sim >= 85) {
        titleBestScore = sim;
        titleBest = c;
      }
    }
    if (titleBest) {
      return { candidate: titleBest, matchType: "fuzzy", confidence: Math.round(titleBestScore) };
    }
  }

  return null;
}