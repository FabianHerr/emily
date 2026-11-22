# Emily: fall-detection watch (McGill CodeJam 16)

**Read `HANDOFF.md` before doing anything.** It is the source of truth: what we are building, decisions already made (do not reopen the discarded options), data contracts, the task list, and what is still unverified.

Two people work in this repo at the same time, each with their own Claude: **Fabian** (backend and web, Mac) and **Sebastian** (watch, Windows). These rules exist so the two sessions do not step on each other.

## How to talk to the team

- Reply in **Spanish**: simple, short, with a concrete example. No long walls of text.
- Everything in the app is in **English**: voice, watch screen, alerts, portal text, and code names (fields, tables, files).
- Do not assume anything marked "sin confirmar" or "por verificar" in HANDOFF.md. Ask or verify.

## Who owns what

| Path | Owner | Notes |
|---|---|---|
| `watch/` | Sebastian | Arduino sketch for the T-Watch S3 |
| `convex/` | Fabian | Backend. `convex/_generated/` is written by `npx convex dev`: never edit it by hand |
| `src/` | Fabian | Family web portal |
| `ml/` | Both, together | Pair task (CJ-21, CJ-22) |
| `HANDOFF.md`, `CLAUDE.md`, `README.md`, `package.json` | Shared | Highest risk of conflicts: see the rules below |

- Stay inside your owner's folders. If a task needs a change in the other person's folder, **stop and tell your human** so they agree on it first. Do not make the change yourself.
- **Only Fabian runs `npx convex dev`.** From another account it creates a different backend with a different URL. Sebastian points the watch at Fabian's URL (HANDOFF.md section 3).
- **Only Fabian adds npm dependencies.** `package.json` and `package-lock.json` conflict easily. If Sebastian needs one, ask Fabian.

## The contract between watch and backend

The HTTP routes and field names in HANDOFF.md section 6 (and in tasks CJ-6 and CJ-14 on the board) are a contract between the two halves. **Never change a route, a parameter name or a response field on your own.** Propose it to your human, both people agree, HANDOFF.md section 6 is updated in the same commit as the code, and the other person is told.

## Git rules

- Work on `main`. The team is two people with separate folders, so branches add more overhead than they save.
- **Before starting work and before every push:** `git pull --rebase`.
- Commit small and often, one task or one working step per commit. Start the message with the task key, in English. Example: `CJ-5: detect falls with thresholds and vibrate`.
- Stage only the files you changed for that task (`git add <paths>`). Do not use `git add -A` or `git add .`: it sweeps in the other person's half-finished files and local junk.
- **Never add Claude as co-author or contributor.** No `Co-Authored-By` trailer and no "Generated with Claude" line. Commits show only the human author.
- **Ask your human before every `git push`**, and before opening or merging a pull request. Show what will be pushed.
- **Never force-push, never rewrite history** (`push --force`, `rebase` of pushed commits, `commit --amend` of pushed commits, `reset --hard` on shared work). If a push is rejected, pull with rebase and try again.
- If a rebase or merge shows a conflict in a file your owner does not own, **stop and tell your human**. Do not pick a side yourself.
- Do not commit broken code to `main`. Before committing: the web app builds (`npm run build`) or the sketch compiles in Arduino IDE.

## Secrets

- Never put API keys, tokens, WiFi passwords or Pushover user keys in the repo or in chat.
- Keys live only in Convex environment variables (`npx convex env set NAME value`), typed by a human.
- `watch/secrets.h` and `.env.local` are git-ignored. Only `watch/secrets.example.h` (empty values) is committed.
- Before each push, check `git diff --cached` for anything that looks like a key.

## Development practices

- **No over-engineering.** If there are two ways, pick the simplest one that works for the demo. No abstractions for a future that is not in the task list.
- **Do the task that is on the board, as specified.** Each task has a full spec and a "Listo cuando..." checklist (board link in HANDOFF.md section 13). A task is done only when every item on that checklist was actually run and passed; say plainly which ones were not run.
- **Update the board** when you start a task (En curso), when it is ready for the other person to check (En review), and when the checklist passes (Hecho).
- **Alerting the family must never depend on an external API answering** (HANDOFF.md sections 7 and 8). Every external call has a timeout and a fallback.
- **Verify APIs before using them.** Check library and API calls against the real docs or source, not memory. Several facts in the original plan were wrong (see HANDOFF.md section 12).
- Put tunable numbers (thresholds, timeouts) as named constants at the top of the file.
- When you learn something the other person needs (a measured time, an API quirk, a decision), write it in HANDOFF.md in the same commit.
- All code is written from scratch during the hackathon. Do not copy code from earlier projects.
- Hackathon deadline: Sunday Nov 22, 12:00 PM. Code freeze Sunday 11:50 AM (moved twice by Fabian on Sunday morning: 8:00, then 11:30). Prefer a working simple version now over a better one later.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
