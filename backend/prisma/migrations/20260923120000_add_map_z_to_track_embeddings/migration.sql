-- The vibe map is now laid out in three dimensions. Existing rows keep their
-- flat positions until the next projection; the map service treats a row
-- without map_z as unplaced and recomputes the layout on first request.
ALTER TABLE "track_embeddings"
  ADD COLUMN "map_z" DOUBLE PRECISION;
