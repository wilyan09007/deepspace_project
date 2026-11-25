/**
 * Tunable limits in one place. Owner-paid costs are only the digest emails
 * (decision #16); everything else is billed to the user who triggers it.
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
/** Owner-paid digest emails per UTC day across the whole app. 0 turns emails off. */
export const DIGEST_EMAIL_DAILY_CAP = 3
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
