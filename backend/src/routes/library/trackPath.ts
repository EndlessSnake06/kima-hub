// Shared helper for resolving a Track's stored filePath against the music
// root, guarding against path traversal (e.g. filePath containing "../../").
import path from "path";
import { config } from "../../config";

/**
 * Join path segments under the music directory, or null if the result escapes
 * it or is the root itself. Use it for every path built from database values,
 * above all before deleting: artist and album names come from file tags, and a
 * tag like "../../tmp/x" would otherwise reach `fs.rmSync`.
 */
export function resolveWithinMusicRoot(...segments: string[]): string | null {
  // Backslashes are normalised because a Windows-scanned library stores them,
  // and `path.resolve` on posix would treat "..\\.." as one odd filename
  // rather than as traversal.
  const normalized = segments.map((s) => s.replace(/\\/g, "/"));
  const resolvedMusicPath = path.resolve(config.music.musicPath);
  const absolutePath = path.resolve(resolvedMusicPath, ...normalized);

  if (!absolutePath.startsWith(resolvedMusicPath + path.sep)) {
    return null;
  }

  return absolutePath;
}
