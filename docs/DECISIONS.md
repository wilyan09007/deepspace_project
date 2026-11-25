# Decision log

Every product and technical decision for Conductor, in the order it was made.
The project owner made each decision below; the coding agent (Claude Code)
researched the platform, laid out options, and implements what was chosen.
Open items at the bottom are waiting on the owner.

| # | Decision | Chosen by | Notes |
|---|----------|-----------|-------|
| 1 | Build a coordination app for teams running AI coding agents (idea "A") | Owner | Picked from a shortlist after reviewing the DeepSpace platform and the 30 Blitz apps |
| 2 | Go with the advanced version: AI planner that dispatches tasks, overlap detection, two-way human control, demo mode, plus the basic board, digest and PR links | Owner | Risk accepted |
| 3 | App name `conductor` → `conductor.app.space` | Owner | |
| 4 | Data shape: team → project (one GitHub repo) → goal → tasks; only team members see team data | Owner | Uses DeepSpace's built-in `'team'` permission level + `team_members` collection |
| 5 | Use DeepSpace built-ins wherever possible instead of hand-rolled infrastructure | Owner | Records, jobs, cron, agent tools (`registerAgent`), presence, integrations, auth |
| 6 | **No hard file locks.** Agent work sessions are long and overlap is expected, so overlap is surfaced and steered, never blocked | Owner | Replaces the lease design that was on the table |
| 7 | Agents connect through the DeepSpace CLI (`npx deepspace agent invoke`) | Owner (via #5) | The built-in transport in the released SDK; MCP exposure is only in DeepSpace's staging prototype |
| 8 | Public GitHub repos only | Owner (via #5) | The built-in `github/*` integration reads public repos only |
| 9 | No demo video; finish as much as possible, leave little unfinished | Owner | |
| 10 | Repo will be made public before submission | Owner | |

| 11 | **Users pay for all AI** with their own DeepSpace sign-in (planning a goal, the assistant, the GitHub reads those trigger). No owner-paid AI | Owner | Answered 2026-11-25. Free accounts get 500 credits/month |
| 12 | Build the in-app assistant **with guardrails**: input limits, cheap topic/injection check, narrow prompt, agent-written text treated as data, team-scoped tools, server-enforced confirmation before pause/resume/reassign, red-team test set | Owner | Answered 2026-11-25 |
| 13 | Teammates join through an **invite link** with a one-time code (7-day expiry) | Owner | Answered 2026-11-25 |
| 14 | Daily digest **by email and on the board** | Owner | Answered 2026-11-25 |
| 15 | Digest is written **without AI** (from the day's events) so it costs nothing | Agent, following #11 | A scheduled job has no signed-in user to bill, so an AI digest could only bill the owner |
| 16 | ~~Digest **emails are the one owner-paid cost**: opt-in per member, at most 3 per day (about 1.3¢ each, so at most ~$1.20/month) | Agent, reconciling #11 with #14 | Scheduled jobs can only bill the owner. Owner can switch emails off by setting the cap to 0 (`DIGEST_EMAIL_DAILY_CAP` in `src/server/core/config.ts`)~~ Superseded by #18 |
| 17 | PR status is refreshed **when a member opens the board** (user-billed, at most once per 10 minutes per project), not by an owner-paid hourly job | Agent, following #11 | Replaces the hourly `pr-refresh` cron in the earlier plan |
| 18 | **Digest emails are on demand and paid by the clicker.** Each digest on the team page has an "Email me" button that sends it to the clicker's own address, billed to their credits (5/day limit). A free "Generate today's digest" button builds it any time. Replaces #16: nothing in the app bills the owner | Owner | Answered 2026-11-25 (option 3). The scheduled 22:00 UTC digest still posts to the team page, free |
| 19 | **GitHub sync:** mirror each task as a GitHub issue (labelled `conductor` + its status, a machine-readable footer, closed when done), read issues and PRs back onto the board, and link issue/PR on every card | Owner | 2026-11-25. Writes go through each user's own GitHub connection (Composio), acting as and billed to that user (~0.05¢ per GitHub call) |
| 20 | **Private repos** work for users who connect GitHub (all reads use their own connection); without a connection, public repos only as before | Agent, following #19 | The test repo `wilyan09007/deepspace_project` is private |
| 21 | Build: needs-you inbox, review gate, task handoff history, merge alerts, auto-release of tasks held by agents offline 2+ hours | Owner | 2026-11-25. Not now: manual task control, branch conventions, human-PR overlap |
| 22 | GitHub sync runs when a member acts (plans a goal, opens the board, clicks Sync), billed to them; nothing syncs on a schedule (that would bill the owner, decision #11) | Agent, following #11 | Status labels on GitHub can lag until someone opens the board |
| 23 | **Renamed Conductor → Squadboard** (`squadboard.app.space`). "Conductor" clashes with a well-known YC-backed app for parallel Claude Code agents; "Pitwall" was rejected as too random; plain names (AgentBoard, AgentsRoom, CodeCrew, Standup…) belong to existing agent tools | Owner | 2026-11-24. GitHub labels/PR lines now say `squadboard`; old `conductor` markers are still read |

## Open — waiting on the owner

None.
