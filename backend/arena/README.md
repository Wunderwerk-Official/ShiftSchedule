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
