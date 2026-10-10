#!/bin/sh
# Download Essentia's MusiCNN model and its ten heads into $1 and check each
# against models.sha256. essentia.upf.edu is intermittently unreachable, so every
# file gets five tries; -f keeps an error page from being saved as a model.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="$1"
mkdir -p "$dest"
fetch() {
    name="$1"; url="$2"
    for attempt in 1 2 3 4 5; do
        if curl -fL --connect-timeout 20 --max-time 300 -o "$dest/$name" "$url" && [ -s "$dest/$name" ]; then
            return 0
        fi
        echo "  $name attempt $attempt failed, retrying in 5s"
        rm -f "$dest/$name"
        sleep 5
    done
    echo "FATAL: could not download $name from $url"
    return 1
}
base="https://essentia.upf.edu/models"
fetch msd-musicnn-1.pb "$base/autotagging/msd/msd-musicnn-1.pb"
for m in happy sad relaxed aggressive party acoustic electronic; do
    fetch "mood_$m-msd-musicnn-1.pb" "$base/classification-heads/mood_$m/mood_$m-msd-musicnn-1.pb"
done
fetch danceability-msd-musicnn-1.pb "$base/classification-heads/danceability/danceability-msd-musicnn-1.pb"
fetch deam-msd-musicnn-2.pb "$base/classification-heads/deam/deam-msd-musicnn-2.pb"
fetch emomusic-msd-musicnn-2.pb "$base/classification-heads/emomusic/emomusic-msd-musicnn-2.pb"
cd "$dest" && sha256sum -c "$here/models.sha256"
