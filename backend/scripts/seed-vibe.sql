-- Seed ~12 tracks with varied mood profiles + UMAP (map_x/map_y) positions
-- into the empty v1 dev DB so the /vibe map + galaxy views have something to render.
-- Run: PGPASSWORD=kima psql -h localhost -p 5455 -U kima -d kima backend/scripts/seed-vibe.sql

-- 1. Artist + Album
INSERT INTO "Artist" ("id", "name", "identityKey", "sortName", "normalizedName", "lastSynced", "enrichmentStatus")
VALUES ('artist_seed_001', 'Test Mood Artist', 'TEST-MOOD-ARTIST-001', 'Test Mood Artist', 'test mood artist', NOW(), 'enriched')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Album" ("id", "rgMbid", "artistId", "title", "year", "coverUrl", "primaryType", "label", "lastSynced", "location")
VALUES ('album_seed_001', 'alb-mbid-001', 'artist_seed_001', 'Test Mood Galaxy', 2026, NULL, 'ALBUM', NULL, NOW(), 'LIBRARY')
ON CONFLICT ("id") DO NOTHING;

-- 2. Tracks with diverse moods. map_x/map_y in [0,1] UMAP space.
--    Each track's moods (7 keys) drive the OKLab mood colour so the galaxy
--    renders visually distinct mood regions.
INSERT INTO "Track" (
  id, albumId, title, trackNo, duration, mime, filePath, fileModified, fileSize,
  energy, loudness, dynamicRange, danceability, valence, arousal,
  instrumentalness, acousticness, speechiness,
  moodHappy, moodSad, moodRelaxed, moodAggressive, moodParty, moodAcoustic, moodElectronic,
  analysisStatus, vibeAnalysisStatus
) VALUES
  ('t_001','album_seed_001','Sunny Happy Day',     1, 200, 'audio/mpeg', '/music/sunny.mp3',   NOW(), 1000000,
   0.70, -5.0, 12.0, 0.60, 0.80, 0.70, 0.10, 0.15, 0.04,
   0.90, 0.05, 0.10, 0.02, 0.30, 0.15, 0.05,
   'done', 'done'),
  ('t_002','album_seed_001','Melancholy Rain',     2, 210, 'audio/mpeg', '/music/melancholy.mp3', NOW(), 1000000,
   0.30, -8.0, 14.0, 0.35, 0.20, 0.15, 0.05, 0.40, 0.02,
   0.05, 0.85, 0.30, 0.05, 0.02, 0.40, 0.05,
   'done', 'done'),
  ('t_003','album_seed_001','Chill Waves',         3, 195, 'audio/mpeg', '/music/chill.mp3',    NOW(), 1000000,
   0.40, -6.0, 13.0, 0.50, 0.50, 0.45, 0.08, 0.50, 0.06,
   0.20, 0.10, 0.80, 0.05, 0.10, 0.50, 0.20,
   'done', 'done'),
  ('t_004','album_seed_001','Aggressive Beats',    4, 180, 'audio/mpeg', '/music/aggressive.mp3',NOW(), 1000000,
   0.90, -3.0, 10.0, 0.75, 0.40, 0.85, 0.15, 0.05, 0.08,
   0.10, 0.05, 0.10, 0.85, 0.40, 0.05, 0.30,
   'done', 'done'),
  ('t_005','album_seed_001','Party Night',         5, 205, 'audio/mpeg', '/music/party.mp3',     NOW(), 1000000,
   0.85, -4.0, 11.0, 0.80, 0.70, 0.80, 0.12, 0.05, 0.04,
   0.50, 0.02, 0.10, 0.10, 0.90, 0.05, 0.60,
   'done', 'done'),
  ('t_006','album_seed_001','Acoustic Morning',    6, 220, 'audio/mpeg', '/music/acoustic.mp3',  NOW(), 1000000,
   0.35, -7.0, 15.0, 0.40, 0.55, 0.30, 0.06, 0.30, 0.03,
   0.30, 0.10, 0.40, 0.02, 0.05, 0.85, 0.05,
   'done', 'done'),
  ('t_007','album_seed_001','Electric Dreams',     7, 190, 'audio/mpeg', '/music/electric.mp3',  NOW(), 1000000,
   0.80, -4.5, 12.0, 0.70, 0.60, 0.75, 0.10, 0.05, 0.07,
   0.20, 0.05, 0.20, 0.15, 0.50, 0.05, 0.90,
   'done', 'done'),
  ('t_008','album_seed_001','Deep Relaxation',     8, 240, 'audio/mpeg', '/music/relax.mp3',     NOW(), 1000000,
   0.20, -9.0, 16.0, 0.25, 0.40, 0.10, 0.03, 0.25, 0.02,
   0.10, 0.20, 0.90, 0.02, 0.05, 0.30, 0.15,
   'done', 'done'),
  ('t_009','album_seed_001','Happy Electronic',    9, 200, 'audio/mpeg', '/music/happyelec.mp3', NOW(), 1000000,
   0.75, -4.0, 11.5, 0.65, 0.70, 0.70, 0.09, 0.10, 0.05,
   0.60, 0.03, 0.15, 0.08, 0.60, 0.10, 0.70,
   'done', 'done'),
  ('t_010','album_seed_001','Sad Acoustic Ballad',10, 230, 'audio/mpeg', '/music/sadballad.mp3', NOW(), 1000000,
   0.25, -8.5, 15.0, 0.30, 0.15, 0.12, 0.04, 0.35, 0.03,
   0.05, 0.75, 0.25, 0.03, 0.02, 0.70, 0.05,
   'done', 'done'),
  ('t_011','album_seed_001','Party Start',        11, 205, 'audio/mpeg', '/music/partystart.mp3',NOW(), 1000000,
   0.88, -3.5, 10.5, 0.82, 0.75, 0.82, 0.14, 0.04, 0.05,
   0.55, 0.02, 0.08, 0.12, 0.92, 0.04, 0.65,
   'done', 'done'),
  ('t_012','album_seed_001','Midnight Chill',     12, 215, 'audio/mpeg', '/music/midnight.mp3',  NOW(), 1000000,
   0.45, -5.5, 13.0, 0.55, 0.45, 0.50, 0.07, 0.25, 0.06,
   0.15, 0.15, 0.70, 0.05, 0.15, 0.25, 0.40,
   'done', 'done');

-- 3. UMAP map_x/map_y positions (normalized 0→1). These are the real
--    coordinates the galaxy scene renders (x/z = disc plane).
--    Arranged so mood clusters form distinct regions:
--      top-left = happy/party (energetic)   -> amber/yellow
--      bottom-right = sad/acoustic (mellow)  -> purple/blue
--      center = relaxed/chill                -> teal/green
--      top-right = aggressive/electronic     -> red/pink
WITH tracks AS (
  SELECT 't_001'::text id, 0.10::float x, 0.20::float y UNION ALL
  SELECT 't_002', 0.20, 0.80 UNION ALL
  SELECT 't_003', 0.50, 0.50 UNION ALL
  SELECT 't_004', 0.80, 0.30 UNION ALL
  SELECT 't_005', 0.90, 0.80 UNION ALL
  SELECT 't_006', 0.15, 0.60 UNION ALL
  SELECT 't_007', 0.85, 0.15 UNION ALL
  SELECT 't_008', 0.40, 0.90 UNION ALL
  SELECT 't_009', 0.70, 0.45 UNION ALL
  SELECT 't_010', 0.25, 0.70 UNION ALL
  SELECT 't_011', 0.88, 0.85 UNION ALL
  SELECT 't_012', 0.55, 0.65
)
INSERT INTO track_embeddings (track_id, map_x, map_y, model_version, analyzed_at)
SELECT id, x, y, 'laion-clap-music', NOW()
FROM tracks
ON CONFLICT (track_id) DO UPDATE SET
  map_x = EXCLUDED.map_x,
  map_y = EXCLUDED.map_y;

-- 4. Verify
SELECT 'tracks' AS tbl, count(*)::text AS c FROM "Track"
UNION ALL SELECT 'embeddings', count(*)::text FROM track_embeddings
UNION ALL SELECT 'mood keys present', count(distinct case when moodHappy is not null then 1 end)::text FROM "Track" WHERE moodHappy is not null;
