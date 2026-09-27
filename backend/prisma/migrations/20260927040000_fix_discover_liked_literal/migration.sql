-- One literal for "user liked a discovery album": every filter that protects
-- kept albums already matches 'discovery_liked'; these rows were written with
-- the short spelling and were invisible to the protections.
UPDATE "OwnedAlbum" SET source = 'discovery_liked' WHERE source = 'discover_liked';
