/**
 * Tunable limits in one place. Nothing in the app bills the owner: every
 * billed call is paid by the user who triggers it (decisions #11, #18).
 */

/** Planner runs per user per UTC day (users pay, but this stops runaway clicks). */
export const PLANNER_RUNS_PER_USER_PER_DAY = 10
/** Teams one user may create per UTC day. */
export const TEAMS_PER_USER_PER_DAY = 20
/** Invite links one user may create per UTC day. */
export const INVITES_PER_USER_PER_DAY = 20
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Minimum gap between user-triggered PR status refreshes for one project (decision #17). */
export const PR_REFRESH_MIN_GAP_MS = 10 * 60 * 1000
export const PR_REFRESH_MAX_PER_RUN = 10
/** Agents unseen this long are marked offline by the stale sweep. */
export const AGENT_STALE_MS = 15 * 60 * 1000
/** Digest emails one user may send themselves per UTC day (billed to them, decision #18). */
export const DIGEST_EMAILS_PER_USER_PER_DAY = 5
/** Planner model (billed to the user who plans). */
export const PLANNER_MODEL = 'claude-sonnet-5-5'
/** Cheap model for the assistant's topic/injection guard (billed to the user chatting). */
export const GUARD_MODEL = 'claude-haiku-5-5'
/** Assistant limits. */
export const ASSISTANT_MAX_CHARS = 2000
export const ASSISTANT_MESSAGES_PER_HOUR = 20
export const ASSISTANT_MAX_TOOL_CALLS = 6
/** Demo pacing. */
export const DEMO_TICK_MS = 3500
export const DEMO_MAX_TICKS = 80

/** Text length caps for anything an agent or user writes. */
export const MAX_NAME = 60
export const MAX_TITLE = 140
export const MAX_SUMMARY = 1000
export const MAX_QUESTION = 1000
export const MAX_GOAL_BODY = 4000
