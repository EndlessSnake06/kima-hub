// Single definition of every localStorage key the audio stack uses. Writers
// and readers must import from here — inline key strings in
// audio-controller.ts drifted from this table until now.
export const STORAGE_KEYS = {
    CURRENT_TRACK: "kima_current_track",
    CURRENT_AUDIOBOOK: "kima_current_audiobook",
    CURRENT_PODCAST: "kima_current_podcast",
    PLAYBACK_TYPE: "kima_playback_type",
    QUEUE: "kima_queue",
    CURRENT_INDEX: "kima_current_index",
    IS_SHUFFLE: "kima_is_shuffle",
    REPEAT_MODE: "kima_repeat_mode",
    PLAYER_MODE: "kima_player_mode",
    VOLUME: "kima_volume",
    IS_MUTED: "kima_muted",
    PODCAST_EPISODE_QUEUE: "kima_podcast_episode_queue",
} as const;
