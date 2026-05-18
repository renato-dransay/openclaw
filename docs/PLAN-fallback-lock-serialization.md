# Plan — Serialize fallback chain on session jsonl lock

## Problem

When a model in a tier's fallback chain fails (rate-limit, transient, contract reject, overflow), the gateway immediately invokes the next model in the chain. Both attempts target the same per-iteration session jsonl file (e.g. `~/.openclaw/agents/<agent>/sessions/wf-<runId>-<step>_story_<N>.jsonl`). The first attempt's codex CLI subprocess does not always release its `.lock` before the next attempt acquires it, producing:

```
SessionWriteLockTimeoutError: session file locked (timeout 10000ms): pid=<prev_pid>
  /Users/renas/.openclaw/agents/<agent>/sessions/wf-...jsonl.lock
```

When the chain is 7 models long, every subsequent fallback hits the same lock and times out, surfacing as:

```
FallbackSummaryError: All models failed (7): openai-codex/...: session file locked
```

The user-visible symptom is a workflow run with `unresolved` stories despite the underlying agent prompt being valid. Recent example: `wf-79265921-…assess-and-ingest_story_0..4` — 14 lock timeouts across 5 parallel loop iterations × ~3 fallback attempts each before the run gave up.

## Proposed fix (sketch)

In the gateway's tier fallback path (likely `src/gateway/dispatcher/*` or `src/agents/openai-transport-stream.ts` adjacent — needs trace), introduce a **lock release barrier** between fallback attempts:

1. After a model attempt fails, `await` the prior subprocess's exit + lock release before spawning the next model. Concretely:
   - Track the `<sessionFile>.lock` path used by the failed attempt.
   - After attempt returns/errors, poll for `.lock` absence (or `fs.flock` succeeds non-blocking) up to ~2s before invoking the next model.
   - If the lock persists past a threshold, force-release (delete the stale `.lock`) — this is the same logic already used at gateway boot for orphan cleanup.

2. Make this barrier configurable via env var: `OPENCLAW_FALLBACK_LOCK_BARRIER_MS=2000`. Default on; explicit `0` disables for legacy behavior.

3. Add a metric/log line per fallback transition so the lock-wait time is visible:
   ```
   [gateway/fallback] model <prev> -> <next> waited_for_lock_ms=<n> released=<true|false>
   ```

## Out of scope (for this plan)

- Reducing fallback chain length per tier (handled at config layer in `~/.openclaw/tiers.json`).
- Preventing the original failure that triggers fallback (handled by workflow YAML diff-size guards in `~/.openclaw/runtime/workflows/*.yml`).
- Preventing parallel loop iterations from racing on per-iteration files (they already have distinct files; the race is purely fallback-internal per-iteration).

## Acceptance criteria

- After fix, a forced overflow on model 1 of a 7-deep chain results in at most ~2s of `waited_for_lock_ms` between attempts, no `SessionWriteLockTimeoutError` lines.
- Existing tests pass; add one new integration test in `src/gateway/dispatcher/*.test.ts` that injects an overflow on the first chain entry and asserts the second entry's invocation does not throw lock errors.
- Manual verification: trigger `assess-health` cron with a contrived oversized prompt, observe gateway log shows clean fallback transitions (no `FallbackSummaryError`).

## Test plan

1. Unit: mock subprocess that deliberately holds the lock for N ms post-exit; assert dispatcher waits.
2. Integration: spawn two sequential model calls against the same `.jsonl` with the barrier disabled vs enabled; barrier-disabled hits timeout, barrier-enabled succeeds.
3. Production canary: deploy to dist, kickstart gateway, monitor `~/.openclaw/logs/gateway.log` for one cron cycle of `assess-health` and `review-pr`. Expect zero `SessionWriteLockTimeoutError` lines.

## Rollback

Revert the dispatcher change. Lock barrier env var defaults preserve old behavior with `OPENCLAW_FALLBACK_LOCK_BARRIER_MS=0`. Backup of `~/.openclaw/openclaw.json` already captured at `openclaw.json.bak.pre-tiers-apply` — unrelated but documents recent config changes.

## Related YAML/config mitigations already shipped

- `~/.openclaw/runtime/workflows/review-pr.yml` — diff size guard 80KB/1500 → 40KB/750
- `~/.openclaw/runtime/workflows/review-pr-fast.yml` — same
- `~/.openclaw/runtime/workflows/assess-progress.yml` — same; cumulative cap 150KB → 75KB
- `~/.openclaw/runtime/workflows/standup-daily-analysis.yml` — relaxed `expects` to allow `STATUS: skipped`
- `~/.openclaw/tiers.json` — added `smart-large-context` tier (drops `gpt-5.2` from fallback); `roxy` reassigned to it

These reduce the _frequency_ of the lock-contention storm by reducing overflows that cascade through the chain in the first place. They do not eliminate the root cause: the gateway's lack of inter-attempt lock serialization.
