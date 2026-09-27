-- Re-analyse every track whose mood values came from the inverted mood heads.
--
-- What was wrong: Essentia's MusiCNN classification heads do not share a
-- column order. Their model metadata ("classes") puts the positive class in
-- column 0 for mood_happy, mood_aggressive, mood_acoustic, mood_electronic
-- and danceability, and in column 1 for mood_sad, mood_relaxed and
-- mood_party. The analyzer read column 1 for all of them, so moodHappy held
-- P(not happy), moodAggressive P(not aggressive), and so on.
--
-- Why the stored values are NOT flipped (value = 1 - value): the analyzer
-- then ran a pairwise softmax over happy/sad and relaxed/aggressive, mixing
-- an inverted head with a correct one. Each stored value in those pairs is
-- sigmoid((-logit(happy) - logit(sad)) / 1.5): the two true values cannot be
-- separated again, and flipping moodHappy just copies moodSad (on the
-- full-library testbed happy + sad = 1 exactly for 2,776 of 8,913 tracks).
-- The same clip-then-softmax produced the 3,778-track pile at exactly 0.5
-- aggressive: calm tracks read P(relaxed) ~ 0.99 and P(not aggressive) ~ 0.99,
-- both clipped to 0.99, split 0.5 / 0.5. An out-of-distribution rescale and
-- a variance shrink toward 0.5 were applied on top. Only re-running the
-- heads recovers the truth, so this migration re-queues the analysis.
--
-- It clears every column the heads (or values derived from them) wrote and
-- sets the track back to 'pending' for the Essentia analyzer, so nothing
-- wrong is shown while re-analysis runs. valence/arousal come from the
-- separate DEAM/emoMusic regression heads and are left alone. CLAP's columns
-- (acousticness, instrumentalness, track_embeddings) are left alone, and the
-- fixed analyzer no longer overwrites them on save. Mood buckets are derived
-- data: the mood bucket worker rebuilds the whole table from the current
-- values on its first cycle after deploy, and again as re-analysis lands.
--
-- Safe to run once (Prisma records it and never runs it again). It is also a
-- no-op for any row already analysed by the fixed analyzer
-- ('2.1b6-enhanced-v3'), so a replay against a restored database cannot
-- re-queue good work.

UPDATE "Track"
SET "moodHappy" = NULL,
    "moodSad" = NULL,
    "moodRelaxed" = NULL,
    "moodAggressive" = NULL,
    "moodParty" = NULL,
    "moodAcoustic" = NULL,
    "moodElectronic" = NULL,
    "danceabilityMl" = NULL,
    "moodTags" = ARRAY[]::TEXT[],
    "analysisStatus" = 'pending',
    "analysisStartedAt" = NULL,
    "analysisError" = NULL,
    "analysisRetryCount" = 0
WHERE "analysisMode" = 'enhanced'
  AND "analysisVersion" IS DISTINCT FROM '2.1b6-enhanced-v3';
