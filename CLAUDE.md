# Emily: fall-detection watch (McGill CodeJam 16)

**Read `HANDOFF.md` before doing anything.** It is the source of truth for this project: what we are building, decisions already made (do not reopen the discarded options), data contracts, the task list, and what is still unverified.

How to work here:

- Reply to the team in **Spanish**: simple, short, with a concrete example. No long walls of text.
- Everything in the app is in **English**: voice, watch screen, alerts, portal text, and code names (fields, tables, files).
- No over-engineering. If there are two ways, pick the simplest one that works for the demo.
- Alerting the family must never depend on an external API answering (see HANDOFF.md sections 7 and 8).
- Never put API keys in the repo or in chat. Keys live only in Convex environment variables (`npx convex env set`). `watch/secrets.h` is git-ignored.
- All code is written from scratch during the hackathon. Do not copy code from earlier projects.
- Tasks live on the sprint board linked in HANDOFF.md section 13. Each task has a full spec and a "Listo cuando..." checklist. When you start or finish a task, update its status there.
- Two people share one backend: only Fabian runs `npx convex dev`. Sebastian works in `watch/` and points the watch at Fabian's URL (HANDOFF.md section 3). Running `npx convex dev` from another account creates a different backend with a different URL.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
