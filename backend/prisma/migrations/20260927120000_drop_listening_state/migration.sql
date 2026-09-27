-- The third playback-position store:
-- PlaybackState (music) and Audiobook/PodcastProgress are the real ones;
-- nothing in this repo ever read or wrote ListeningState.
DROP TABLE IF EXISTS "ListeningState";
