// Centralized runtime constants for webhook and conversation handling

export const MAX_MESSAGE_CHARS = 800;

// Rate limits
export const RATE_LIMIT_WINDOW_MS = 30_000; // 30s
export const RATE_LIMIT_MAX_EVENTS = 4; // per window per user
export const GLOBAL_RATE_LIMIT_MAX = 200; // per window across all users

// Replay protection
export const REPLAY_TTL_MS = 15 * 60_000; // 15 minutes
export const MAX_EVENT_AGE_MS = 10 * 60_000; // 10 minutes


