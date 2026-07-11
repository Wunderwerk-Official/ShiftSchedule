# Agent test arena

Benchmarks the AI planning agent against a hard, realistic case: an
anonymized export of a large radiology practice (24 clinicians, 35 sections,
163 weekly template slots, 4 locations), stored in `fixture_complex.json`.

It runs the **real** agent solver in-process (same code path as production),
so executing it inside the production backend container measures the actual
self-hosted Qwen model on the real endpoint.

## What it measures

Each run prints one `ARENA_REPORT {…}` JSON line with: model, duration,
iterations, moves accepted/rejected, input/output tokens, open slots
seed→final, the improvement note (which quality tiers got better), and the
final violation summary. After it, the model's last few reasoning texts are
printed for qualitative review.

## Scenarios (`--scenario`)

- `base` — the practice data unchanged.
- `vacation-wave` — 5 clinicians on vacation for the whole range (scarcity,
  produces genuine open slots the agent must fill).
- `understaffed` — the 4 most-flexible clinicians removed (sick calls); rare
  qualifications lose their usual cover.

## Two ways to run it

### A. GitHub Actions UI (no local setup)

Actions → **Agent arena (truhn.ai)** → **Run workflow**, then fill in:

| field | example |
|---|---|
| start | `2026-02-02` |
| days | `3` or `7` |
| timeout | `900` (35B) / `1800` (122B, it is ~40× slower) |
| model | `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4` or `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4` |
| scenario | `base` / `vacation-wave` / `understaffed` |

Run **one at a time** (the endpoint shares a GPU). Open the finished run →
job `arena` → step "Run the arena case on the LXC" → copy the `ARENA_REPORT`
line (and the `--- thought ---` blocks under it).

### B. Directly on the server

```
ssh -J dtruhn@49.13.89.75:4444 dtruhn@10.10.10.6      # then on the box:
cd /opt/app
docker compose -f docker-compose.proxied.yml exec -T backend \
  python -m backend.arena.run --start 2026-02-02 --days 3 \
    --timeout 900 --model Qwen/Qwen3.5-35B-A3B-GPTQ-Int4 --scenario base
```

### C. Locally with the mock provider (no LLM, validates plumbing only)

```
cd <repo> && AGENT_PROVIDER=mock \
  python -m backend.arena.run --start 2026-02-02 --days 3 --scenario understaffed
```

## Baseline findings (as of v1.29)

Seed quality from the heuristic before the agent runs (measured locally):

| scenario | days | open slots | short days |
|---|---|---|---|
| base | 3 | 0 | 15 |
| base | 7 | 2 | 22 |
| vacation-wave | 3 | 12 | 8 |
| understaffed | 3 | 0 | 10 |

Key insight: short days dominate, and they sit on **fully-booked** days —
fixing one means swapping a slot off someone else. `list_short_days` now
precomputes `fix_options` per case (adjacent qualified slots, who holds each,
whether taking it would just shorten that holder) so the model does not spend
iterations re-deriving adjacency. On the base 3-day case that turns 14 of 15
short days into concrete one-call options and flags the 1 unfixable case.

Head-to-head on the practice Wednesday (single day, clean seed, 5 short days):

| model | duration | iterations | moves | short days |
|---|---|---|---|---|
| Qwen 35B-A3B | 205 s | 13 | 4 | 5 → 3 |
| Qwen 122B | 1195 s | 20 | 10 | 5 → 2 |

Recommendation: 35B as the everyday model (a solid result in minutes), 122B
as a "quality mode" for important weeks with a 20–30 min budget.

## Evaluation round 3 (v1.29 fix_options, multi-day, on the real endpoint)

Start 2026-02-02:

| model | scenario | days | duration | iter | moves acc/rej | short days | open slots |
|---|---|---|---|---|---|---|---|
| 35B | base | 3 | 402 s | 51 | 20/0 | 15 → 5 | 0 → 0 |
| 35B | understaffed | 3 | 696 s | 97 | 24/37 | 10 → 5 | 0 → 0 |
| 35B | base | 7 | 317 s | 55 | 30/84 | 22 → 19 | 2 → 0 |
| 122B | base | 3 | 1110 s | 67 | 22/0 | 15 → 4 | 0 → 0 |

The 122B confirms its "quality mode" role: best short-day reduction of the
round (15 → 4, every batch dry-run-validated, zero rejections, remaining
cases correctly explained), at ~2.8× the 35B's wall clock on the same case.

What worked: the structurally-unfixable flag is respected (empty
`fix_options` cases are skipped and named as such in the summaries), and on
the clean base case the model applied the precomputed options directly —
zero rejected batches.

What didn't: `fix_options` were only adjacency-checked, not legality-checked.
On real data 37–46% of the presented options would create WEEKLY_HOURS /
SAME_LOCATION_PER_DAY / SPLIT_SHIFT / OVERLAP violations; the model had to
falsify them one dry-run (or rejected batch) at a time. That produced the
37/84 rejections above, a ~50-iteration unproductive stretch in the
understaffed run, and an early surrender on the 7-day run (316 s of 1800 s
used, 19 of 22 short days left). The understaffed run also ignored the
repairable seed WEEKLY_HOURS violation (tier 1) until iteration 96, and one
run ended accidentally by narrating an intention instead of calling a tool.

Changes derived from this round (v1.30): every fix option is legality-checked
upfront (`blocked_by` lists the violation codes the direct swap would create,
legal options sort first, `fixable` counts only genuinely fixable cases —
reclassifying e.g. the two all-blocked Grace-Hopper cases on base-7d), the
problem digest names the concrete repairable seed violations instead of a
bare count, the overview no longer shows out-of-range violation noise, and
the prompt now spells out batch-apply of pre-validated options, an explicit
not-done-while checklist, and the no-narration rule.

## v1.30 verification (Qwen 35B, same cases re-run on the real endpoint)

| scenario | days | v1.29 | v1.30 |
|---|---|---|---|
| understaffed | 3 | 696 s, 97 iter, 10 → 5 short, tier-1 violation never fixed | 234 s, 16 iter, 10 → 6 short, **tier-1 violation fixed (1 → 0)**, hours deviation improved |
| base | 7 | 317 s, 55 iter, 22 → 19 short, 2 → 0 open, early surrender | 442 s, 49 iter, **22 → 10 short**, 2 → 1 open |

The understaffed result is strictly better on the quality ladder (the
repaired hard violation outranks one extra short day) at a third of the
wall clock and an eighth of the tokens; the model demonstrably reads
`blocked_by` ("fix_options all blocked — skip") and names skipped cases in
its summary. The 7-day run more than tripled the short-day yield and no
longer surrenders, but exposed a move-ordering trap: eager short-day swaps
consumed the slack one open slot needed (tier-2 regression 0 → 1). Two
follow-up tweaks address it: the prompt now requires finishing ALL open-slot
work before any short-day fix, and list_short_days warns that options go
stale after apply_moves (stale options were behind most of the remaining
rejected batches).
