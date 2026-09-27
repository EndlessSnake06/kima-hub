#!/usr/bin/env bash
# Download the evaluation audio (and the labels we may not redistribute) into
# the data root, verify every archive against SHA256SUMS, and unpack it into the
# layout datasets.py reads. Nothing here is committed: the data root defaults to
# eval/.cache/data, which .gitignore already excludes.
#
#   ./fetch_data.sh                       every set except pmemo (manual, see below)
#   ./fetch_data.sh mtt soundtracks       only these
#   KIMA_EVAL_DATA=/big/disk ./fetch_data.sh memo2496
#
# Sizes: mtt 3.0 GB, soundtracks 0.2 GB, isovat 0.3 GB, deam 1.3 GB,
#        merge 1.2 GB, memo2496 12.3 GB, pmemo 0.7 GB.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="${KIMA_EVAL_DATA:-$here/.cache/data}"
dl="$root/_downloads"
mkdir -p "$dl"

unpack() {  # unpack <zip> <dir>
  mkdir -p "$2"
  unzip -q -o "$1" -d "$2"
}

get() {  # get <relative-name> <url>   -- download once, then verify
  local rel="$1" url="$2" dest="$dl/$1"
  mkdir -p "$(dirname "$dest")"
  if [ ! -f "$dest" ]; then
    echo "downloading $rel"
    curl -fsSL --retry 5 -C - -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  local want
  want="$(awk -v f="$rel" '$2 == f {print $1}' "$here/SHA256SUMS")"
  [ -n "$want" ] || { echo "no checksum recorded for $rel" >&2; exit 1; }
  local have
  have="$(shasum -a 256 "$dest" | awk '{print $1}')"
  if [ "$have" != "$want" ]; then
    echo "CHECKSUM MISMATCH for $rel: got $have, expected $want" >&2
    exit 1
  fi
  echo "verified $rel"
}

fetch_mtt() {
  local base=https://mirg.city.ac.uk/datasets/magnatagatune
  get mtt/comparisons_final.csv "$base/comparisons_final.csv"
  for p in 001 002 003; do get "mtt/mp3.zip.$p" "$base/mp3.zip.$p"; done
  mkdir -p "$root/mtt/audio"
  cp "$dl/mtt/comparisons_final.csv" "$root/mtt/comparisons_final.csv"
  cat "$dl/mtt/mp3.zip.001" "$dl/mtt/mp3.zip.002" "$dl/mtt/mp3.zip.003" > "$dl/mtt/mp3_full.zip"
  unpack "$dl/mtt/mp3_full.zip" "$root/mtt/audio"
  rm "$dl/mtt/mp3_full.zip"
}

fetch_soundtracks() {  # labels are vendored in labels/soundtracks; this is the audio
  get soundtracks/Set1.zip https://osf.io/download/t5pk3/
  get soundtracks/Set2.zip https://osf.io/download/yn7vg/
  unpack "$dl/soundtracks/Set1.zip" "$root/soundtracks/set1"
  unpack "$dl/soundtracks/Set2.zip" "$root/soundtracks/set2"
}

fetch_isovat() {  # no licence file upstream: fetched, never vendored; pinned by commit
  local commit=f62317920edd85ef4862e8f77633dc19f1a54c92
  if [ ! -d "$root/isovat/.git" ]; then
    git clone --quiet https://github.com/CalePlut/IsoVAT_Dataset "$root/isovat"
  fi
  git -C "$root/isovat" checkout --quiet "$commit"
  [ "$(git -C "$root/isovat" rev-parse HEAD)" = "$commit" ] || { echo "isovat commit mismatch" >&2; exit 1; }
  echo "verified isovat @ $commit"
}

fetch_deam() {
  get deam/DEAM_audio.zip https://cvml.unige.ch/databases/DEAM/DEAM_audio.zip
  get deam/DEAM_Annotations.zip https://cvml.unige.ch/databases/DEAM/DEAM_Annotations.zip
  unpack "$dl/deam/DEAM_audio.zip" "$root/deam"
  unpack "$dl/deam/DEAM_Annotations.zip" "$root/deam"
}

fetch_merge() {
  get merge/MERGE_Audio_Complete.zip "https://zenodo.org/records/13939205/files/MERGE_Audio_Complete.zip?download=1"
  unpack "$dl/merge/MERGE_Audio_Complete.zip" "$root/merge"
}

fetch_memo2496() {  # labels are vendored in labels/memo2496; this is the 12.3 GB audio
  get memo2496/MusicRawData.zip https://ndownloader.figshare.com/files/52292060
  unpack "$dl/memo2496/MusicRawData.zip" "$root/memo2496/audio"
}

fetch_pmemo() {  # hosted on Google Drive behind an interactive page: manual step
  local f="$dl/pmemo/PMEmo2019.zip"
  if [ ! -f "$f" ]; then
    echo "PMEmo must be downloaded by hand: open"
    echo "  https://drive.google.com/drive/folders/1qDk6hZDGVlVXgckjLq9LvXLZ9EgK9gw0"
    echo "save PMEmo2019.zip as $f and re-run: ./fetch_data.sh pmemo"
    return 0
  fi
  get pmemo/PMEmo2019.zip unused
  unpack "$f" "$root/pmemo"
}

sets=("$@")
[ ${#sets[@]} -gt 0 ] || sets=(mtt soundtracks isovat deam merge memo2496)
for s in "${sets[@]}"; do
  case "$s" in
    mtt|soundtracks|isovat|deam|merge|memo2496|pmemo) "fetch_$s" ;;
    *) echo "unknown set: $s (mtt soundtracks isovat deam merge memo2496 pmemo)" >&2; exit 1 ;;
  esac
done
echo "data root: $root"
