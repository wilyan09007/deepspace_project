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

## Open — waiting on the owner

| # | Question | Recommendation |
|---|----------|----------------|
| A | Who pays for AI planning and digests? | Revised after owner said their credits are capped: each user pays for AI they trigger (planning, assistant) with their own DeepSpace credits; owner pays only a small capped daily digest; demo and sample cost nothing. See BUILD_NOTES "Who pays" |
| E | In-app assistant guardrails (owner asked for off-topic refusal and red-team hardening) | Guard classifier + narrow prompt + untrusted-data rule + scoped tools + red-team test set. See BUILD_NOTES |
| B | How do teammates join a team? | Invite link with a one-time code |
| C | Daily digest channel | Email (built-in `email/send`, no setup per team); Slack later |
| D | In-app assistant ("what is agent X doing?") using the same tools | Yes, after the core loop works |
