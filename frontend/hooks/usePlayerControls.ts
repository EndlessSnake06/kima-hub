"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlaybackProgress } from "@/hooks/usePlaybackProgress";

/**
 * The playback wiring every full-surface player shares. The state stays split
 * across the four contexts so a currentTime update re-renders only the
 * components reading progress; this hook gathers the reads, it does not merge
 * the sources.
 */
export function usePlayerControls() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        activeOperation,
        queue,
        currentIndex,
    } = useAudioState();

    const { isPlaying, isBuffering, canSeek, downloadProgress, audioError } = useAudioPlayback();

    const { duration, displayTime, progress } = usePlaybackProgress();

    const {
        pause,
        resumeWithGesture,
        next,
        previous,
        setPlayerMode,
        returnToPreviousMode,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
    } = useAudioControls();

    return {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        activeOperation,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        duration,
        displayTime,
        progress,
        pause,
        resumeWithGesture,
        next,
        previous,
        setPlayerMode,
        returnToPreviousMode,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
    };
}
