/** Server-side clocks for human matches (PRIVATE / GLOBAL). */
export const TURN_TIMEOUT_MS = 60_000;
export const SETUP_TIMEOUT_MS = 60_000;
export const DISCONNECT_GRACE_MS = 60_000;
/** Consecutive auto-played turns after which the absent player loses by TIMEOUT. */
export const MAX_MISSED_TURNS = 3;
export const SCHEDULER_INTERVAL_MS = 1_000;
