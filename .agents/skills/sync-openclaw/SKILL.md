---
name: sync-openclaw
description: Sync the local fork with upstream openclaw, rebuild, restart all services, and verify everything is running (gateway, Mattermost channels, CRONs, mem0, slash commands).
---

# Sync OpenClaw

Use this skill to sync the local repo with upstream, rebuild, and redeploy. Follow every step in order. Do not skip steps. If any step fails, stop and report.

## Branch model

The fork uses a three-branch flow:

```
upstream/main  →  main  →  dransay  →  origin/dransay
```

- `main` is a clean local mirror of `upstream/main`. **Never push `main` to `origin`.**
- `dransay` is the working branch that carries fork-only commits (e.g. Mattermost slash-owner serialization, follow-redirects exclude, host-aware merge fixes). Sync runs here and pushes here.
- `origin/dransay` is the only branch this skill pushes to.

## Steps

### 1. Commit local changes on dransay (if any)

Start on `dransay` (the default working branch). Check `git status`. If there are uncommitted changes, commit them via `scripts/committer "<msg>" <files...>` before proceeding. Use `--no-verify` only if pre-commit failures are pre-existing and unrelated to the changes.

### 2. Sync upstream → main

```sh
git checkout main
git fetch upstream
git merge upstream/main -X ours --no-edit
```

If there are conflicts even with `-X ours`, stop and report to the user. Do not force-resolve.

### 3. Merge main → dransay

```sh
git checkout dransay
git merge main -X ours --no-edit
```

`-X ours` keeps fork-side resolutions when both branches touch the same line. **This regularly drops new upstream imports/exports** — after this step, expect to fix tsgo errors caused by missing imports that landed on `main` but were lost in the merge. Resolve them in the same commit as other unblockers (step 6 below).

### 4. Install dependencies

```sh
pnpm install
```

If install fails on `ERR_PNPM_NO_MATURE_MATCHING_VERSION` for a freshly-pinned upstream override (e.g. `follow-redirects@1.16.0` released < 48 h ago), add the exact pin to `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` list — mirror the existing `axios@1.15.0` style — and retry. This is a fork-side unblocker that's safe to land because upstream already pinned the version intentionally; commit it together with any other sync unblockers in step 6.

### 5. Rebuild

```sh
pnpm build
pnpm ui:build
```

Both must succeed. If `ui:build` fails on missing deps, rerun `pnpm install` and retry once. `pnpm build` regenerates `src/canvas-host/a2ui/.bundle.hash`; commit the hash as its **own** commit (do not bundle it with other changes) per the repo CLAUDE.md A2UI rule.

### 6. Commit any sync unblockers

Run `pnpm check` (or let the committer hook run it) to surface anything broken by the merge. Common findings on dransay after an upstream sync:

- **Lost imports** from `-X ours` — e.g. `tsgo` reports `Cannot find name 'X'` because a new upstream import landed on `main` but the merge kept the older dransay-side line. Fix by re-adding the import and rerunning `pnpm tsgo`.
- **Runtime import cycles** flagged by `pnpm check:import-cycles` — usually a fork-side re-export in `extensions/<plugin>/runtime-api.ts` that pulls a heavy graph back through itself. Prefer a thin barrel (e.g. `extensions/mattermost/slash-route-api.ts`) over the runtime barrel for lazy-loaded entry points.
- **`minimumReleaseAge` exclude misses** (see step 4).

Group these into a single commit on dransay (e.g. `build: unblock dransay sync after upstream merge`). The `.bundle.hash` from step 5 stays in its own follow-up commit.

### 7. Ensure Docker/OrbStack is running (for Mattermost + memory stack only)

```sh
orb start  # or: open -a OrbStack
```

Wait until `docker info` succeeds.

### 8. Start Mattermost (if not running)

```sh
cd /Users/renas/Projects/mattermost/deploy && docker compose up -d
```

Wait until `curl -s http://localhost:30065/api/v4/system/ping` returns 200.

### 9. Start memory stack (if not running)

```sh
docker compose -f docker-compose.memory.yml up -d
```

### 10. Restart the gateway (host, via launchd)

```sh
openclaw gateway restart
```

**CRITICAL: The gateway runs on the HOST via launchd, NOT in Docker.**
Do NOT run `docker compose -f docker-compose.yml up -d` or `docker build -t openclaw:local .` for the gateway.
Docker is only used for Mattermost and the memory stack. Running the gateway in Docker breaks agent access to host tools (gh, git, etc.).

### 11. Restart the consumer (Reactor + workflow engine)

```sh
launchctl kickstart -k gui/501/com.openclaw.consumer
```

The consumer runs the Reactor (60s PR polling loop), the workflow watchdog, and the step executor. It must be restarted after a rebuild so it picks up the new code. Wait 5 seconds, then verify:

```sh
tail -5 ~/.openclaw/runtime/logs/runtime.log
```

You should see "Reactor started — polling every 60s" and "Consumer started". If not, check for PID lock issues (`rm -f ~/.openclaw/runtime/consumer.pid` and retry).

### 12. Verify everything

Run all checks and report results in a table:

| Check               | Command                                                                  | Expected                                                            |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Gateway             | `openclaw channels status --probe`                                       | "Gateway reachable"                                                 |
| Mattermost channels | same output                                                              | All configured bots show "connected" + "works"                      |
| CRONs               | `openclaw cron list`                                                     | All jobs listed with schedules                                      |
| mem0                | `curl -s http://localhost:8420/health`                                   | `{"status":"ok"}`                                                   |
| Reactor             | `grep "Reactor started" ~/.openclaw/runtime/logs/runtime.log \| tail -1` | "Reactor started — polling every 60s" (timestamp within last 2 min) |

If any check fails, investigate and fix before reporting success.

### 13. Push dransay to origin

```sh
git push origin dransay
```

**Only `dransay` is pushed.** `main` stays local as a clean upstream mirror — never `git push origin main` from this skill.

## Notes

- **The gateway runs on the HOST via launchd (`ai.openclaw.gateway`), NOT in Docker.** Never containerize it — agents need direct access to host tools (gh, git, node, etc.).
- Do NOT run `docker build -t openclaw:local .` or `docker compose -f docker-compose.yml up -d` — these would start a competing Docker gateway that breaks everything.
- Docker is ONLY for: Mattermost (`docker-compose` in `/Users/renas/Projects/mattermost/deploy`) and the memory stack (`docker-compose.memory.yml`).
- Mattermost lives in a separate repo at `/Users/renas/Projects/mattermost/deploy`.
- mem0 is exposed on port 8420 (mapped from container port 8000).
- If `pnpm build` is skipped after a merge, the mattermost plugin and other extensions WILL break at runtime due to stale dist output. Never skip the build step.
