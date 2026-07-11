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

- `base` — the practice data unchanged. NOTE: the fixture contains the
  practice's REAL vacations — start `2026-02-16` hits the school-holiday
  week with nine clinicians away at once, the hardest realistic case in the
  data (heuristic seed: 27 of 146 required positions stay open).
- `vacation-wave` — 5 clinicians on vacation for the whole range (scarcity,
  produces genuine open slots the agent must fill).
- `understaffed` — the 4 most-flexible clinicians removed (sick calls); rare
  qualifications lose their usual cover.
- `crunch` — the 2 most-flexible clinicians NOT on vacation call in sick for
  the whole range. Pointed at 2026-02-16 this stacks sick calls on top of
  the real nine-person vacation wave.
- `oncall` — the overnight on-call duty (kept at requiredSlots=0 and staffed
  by hand in the real practice) becomes required: 1 person per on-call slot,
  in-range on-call assignments cleared. Hard because of the rest-day rule —
  each on-call consumes the clinician's neighbouring days too.
- `pinned` — on each day the two most-flexible available clinicians are
  pre-booked (manual, immutable) on the day's lowest-priority slots: the
  "boss has an evening meeting" anchors the agent must plan around.
- `daynight` — `oncall` plus the production trap: the weekend on-call
  becomes a day duty 08:00-20:00 AND a night duty 20:00-08:00(+1) on the
  same day. A naive solver put the SAME person on both (a 24h shift); two
  different people is the only humane answer.

## Two ways to run it

### A. GitHub Actions UI (no local setup)

Actions → **Agent arena (truhn.ai)** → **Run workflow**, then fill in:

| field | example |
|---|---|
| start | `2026-02-02` |
| days | `3` or `7` |
| timeout | `900` (35B) / `1800` (122B, it is ~40× slower) |
| model | `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4` or `Qwen/Qwen3.5-122B-A10B-GPTQ-Int4` |
| scenario | `base` / `vacation-wave` / `understaffed` / `crunch` / `oncall` / `pinned` / `daynight` |
| strategy | `repair` (heuristic seed + LLM repair) / `day_by_day` (LLM builds each day from scratch) |

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
longer surrenders, but suggested a move-ordering trap (short-day swaps
before open-slot work). Two follow-up tweaks: the prompt now requires
finishing ALL open-slot work before any short-day fix, and list_short_days
warns that its options go stale after apply_moves.

Re-run of base 7d with those tweaks: **27 iterations / 247 s, 22 → 7 short
days**, the fillable open slot filled FIRST (iteration 6, with its only
legal candidate) and the other correctly diagnosed as unfillable — verified
against the seed: S10 2026-02-05 has zero eligible candidates, so 1 open
slot is the tier-2 optimum for this seed. (The v1.29 run's "2 → 0 open"
came from a different heuristic seed; CP-SAT seeds vary slightly per run.)

## Evaluation round 4 (day-by-day strategy v1.31, on the real endpoint)

First round of `--strategy day_by_day` (the LLM builds each day from
scratch like a human planner: `get_day_priorities` lists the day's open
slots scarcity-sorted, `suggest_day_blocks` returns a pre-validated
contiguous work block per candidate — the "Anschlussverwendung" — and the
model applies whole blocks). Qwen 35B, start 2026-02-02, 3 days, timeout
900 s; the repair rows are the v1.30 references on the same cases.

| scenario | strategy | duration | iter | moves acc/rej | short days | open slots |
|---|---|---|---|---|---|---|
| base | repair (ref) | 402 s | 51 | 20/0 | 15 → 5 | 0 → 0 |
| base | day_by_day | 393 s | 100 (cap) | 75/0 | → 2 | 87 → 12 |
| understaffed | repair (ref) | 234 s | 16 | 16/28 | 10 → 6 | 0 → 0 |
| understaffed | day_by_day | 296 s | 100 (cap) | 73/0 | → 3 | 87 → 14 |

What worked: procedure adherence was flawless — strict priorities →
suggestion → apply-whole-block loops, ZERO rejected batches across both
runs (the pre-validated blocks hold against the real apply gate), and
short days are excellent by construction (2-3 vs the repair path's 5-6).

What didn't: both runs died on the iteration cap (AGENT_MAX_ITERATIONS,
then 100) with ~500 s of their 900 s budget unused, leaving 12/14 required
slots open — a tier-2 failure that outranks every short day won. The
procedure costs THREE LLM rounds per placement (priorities, suggestion,
apply) at ~20k input tokens each (~2M per run). One prompt ambiguity
surfaced: the model agonized over "block length first" vs fairness when
several candidates met the daily minimum.

Changes derived (v1.32): `suggest_day_blocks` auto-select (omit slot_key,
pass dateISO — it picks the scarcest still-fillable slot itself and
returns `day_complete=true` once nothing fillable remains), the day prompt
pipelines apply_moves + suggest_day_blocks into ONE message per placement,
candidate choice is disambiguated (pre-sorted: daily minimum met first,
then lowest ytd_worked_pct; extra length is a tie-breaker, not a goal),
`get_day_priorities` caps its list at 20 entries, and the iteration cap
default was raised 100 → 1000 (a runaway backstop, not a budget — the
timeout is the real limit).

## v1.32 verification (same cases re-run on the real endpoint)

| scenario | v1.31 day-by-day | v1.32 day-by-day |
|---|---|---|
| base | 393 s, 100 iter (cap), 87 → 12 open, 2 short | 438 s, 120 iter, **87 → 0 open**, 4 short, 0 rejections |
| understaffed | 296 s, 100 iter (cap), 87 → 14 open, 3 short | 326 s, 112 iter, **87 → 3 open** (each proven unfillable, named in the summary), 6 short, 1 rejection |

The tier-2 goal is reached. Base now fills EVERY required slot and beats
repair on the full quality ladder (0 open for both, then 4 vs 5 short
days) at comparable wall clock. Understaffed fills 84 of 87; the three
left (S42/S61/S64 on 2026-02-04, Echo/IRM tout ZK) each have
eligible_count 0 after the last batch — correctly reported instead of
forced — but the repair seed does cover them by packing the scarce people
differently, so repair stays ahead on understaffed (0 open, equal 6 short
days). Verdict: day-by-day is now the better strategy on the base case and
the stronger short-day constructor everywhere; repair remains the safer
pick under scarcity.

Observed mechanics: Qwen 35B rarely emits two tool calls in one message,
so instead of the intended 1-round pipeline it alternates apply and
suggest as single-call rounds — 2 rounds per placement (down from 3). With
the cap at 1000 that is comfortable: 120/112 iterations, ~2M input tokens,
no cap exhaustion, and both runs now END via day_complete + summary
instead of being cut off mid-construction.

## Evaluation round 5 (v1.33 priority order, the REAL hard week, 35B vs 122B)

The fixture is the anonymized real February export — including the actual
school-holiday week (start 2026-02-16, 5 days) with NINE clinicians on
vacation at once. Round 5 points the arena at that week instead of the calm
2026-02-02, adds the `crunch` and `oncall` scenarios distilled from it, and
tests the priority-ordered day processing (v1.33: single-candidate slots →
on-call → template priority instead of chronological) on both Qwen models.

All runs start 2026-02-16, 5 days, on the real endpoint:

| scenario | model / strategy | duration | iter | moves acc/rej | short days | open slots |
|---|---|---|---|---|---|---|
| base | 35B repair (reference) | 656 s | 114 | 11/59 | 10 → 8 | 27 → 20 |
| base | 35B day_by_day | 461 s | 139 | 107/0 | → 3 | 127 → 20 |
| base | 122B day_by_day | 1004 s | 139 | 107/0 | → 3 | 127 → 20 |
| crunch | 35B day_by_day | 402 s | 131 | 90/0 | → 4 | 127 → 37 (heuristic seed: ~54 open) |
| oncall | 35B day_by_day | 468 s | 135 | 110/0 | → 5 | 132 → 22, **all 5 on-call nights staffed** |

Findings:

- **Day-by-day beats repair on the real hard week in every tier.** Both end
  at the structural limit of 20 open slots, but day-by-day gets there with
  3 short days instead of 8, zero rejections instead of 59, 30% less wall
  clock and 35% fewer input tokens. The repair run burned its budget
  falsifying stale fix_options ("no blocked_by but at capacity").
- **35B == 122B under day-by-day.** Identical quality (20 open, 3 short,
  same hours deviation, same bonus) at 2.2× the wall clock for the 122B:
  the pre-validated tools carry the intelligence, so the model mostly
  ratifies the top candidate. With this strategy the 35B is the everyday
  AND the quality choice; reserve the 122B for repair-style work.
- **Priority processing works**: the oncall run staffs every Garde night
  (rest-day rule respected) — previously on-call was reached last, after
  the people who could take it were consumed. Both models end each day via
  day_complete and name the unfillable slots in their summaries.
- Neither Qwen emits two tool calls in one message, so the intended
  1-round pipeline runs as alternating apply/suggest rounds (2 per
  placement, down from 3 pre-v1.32) — comfortable within budget.
- One model hesitation found and fixed (v1.34): a candidate at 42h against
  a 36h contract looked illegal to the model, but that clinician's PERSONAL
  tolerance is 10h. suggest_day_blocks now exposes week_hours_max
  (contract + personal tolerance) per candidate, marks on-call slots
  (on_call=true), and the run-log open-slot lists cap at 200 (80 truncated
  the from-scratch seed side of the report).

v1.34 verification (35B, oncall, same week): 566 s, 134 iter, 108/0 moves,
132 → 24 open (within run variance of v1.33's 22), 5 short days, all Garde
nights staffed again. The report's seed side now shows the exact 132, and
the hours hesitation is gone from the reasoning — the model cites the
take-the-first-candidate procedure instead of second-guessing legal
above-contract hours.

## Evaluation round 6 (v1.35 duty pre-pass + rescue + 24h guard, hard-test matrix)

Round 6 was driven by two PRODUCTION findings: a 7-day live run left the
whole weekend (including its on-call) empty because chronological day
building spends the weekly-hours budget on Monday-Thursday first, and the
solver once put ONE person on Saturday's day duty 08:00-20:00 AND night
duty 20:00-08:00 — a 24-hour shift. v1.35 answers with the DUTY PRE-PASS
(all on-call/duty slots of the range are staffed in one conversation
BEFORE any day work), suggest_rescue_moves (depth-1 rearrangement of the
agent's own placements, pre-validated net-gain batches), the
overloaded=true guard (>16h days sort last; two people on two duties beat
one person on 24 hours), and the slots-x-10 iteration budget.

The matrix (all Qwen 35B, day_by_day, v1.35 on the real endpoint):

| case | duration | iter | moves acc/rej | short days | open slots |
|---|---|---|---|---|---|
| daynight 2026-02-16 +7d | 534 s | 152 | 111/0 | → 5 | 137 → 34, **9/9 duties staffed, Sat day+night = two different people** |
| pinned 2026-02-16 +5d | 481 s | 134 | 93/0 | → 8 | 118 → 27, zero new violations around 10 immutable anchors |
| understaffed 2026-02-02 +3d | 325 s | 114 | 86/0 | → 8 | 87 → **1** (v1.32: 3; the last slot proven rescue-free) |
| crunch 2026-02-16 +5d | 389 s | 122 | 82/0 | → 5 | 127 → 47 (v1.33: 37 — but no stacked monster days, best hours balance of the case) |
| base 2026-02-16 +5d | 519 s | 152 | 117/0 | → 5 | 127 → **16** (repair, v1.33-35B and 122B all plateaued at 20 — rescue cracks it) |
| daynight 2026-04-03 +4d (Easter) | 60 s | 31 | 9/0 | → 0 | 9 → **0**, every holiday/weekend duty staffed day+night |
| vacation-wave 2026-02-02 +3d | 376 s | 103 | 81/0 | → 5 | 87 → **8** (heuristic seed: 12) |
| base 2026-02-09 +14d (endurance) | 1171 s | 327 | 253/0 | → 9 | 274 → **23**, ~6M input tokens, no budget/cap issues across two weeks |

Zero rejected batches across all eight runs. The rescue tool was used
correctly everywhere: applied where it gains (base: freed Paul Dirac for
S30; understaffed/vacation-wave: one net-gain batch each), and used as
proof of unfillability otherwise. The crunch regression (47 vs 37 open) is
the intended trade — v1.33 filled more by piling >16h days onto the few
remaining people, which the 24h guard now discourages.

Frictions found and fixed on top (this round's follow-up): the rescue
search capped at 8 stuck slots and stayed silent about the rest (a real
day had 14 — the model puzzled over the missing six; now cap 16 +
not_searched list), and already-complete days still opened a conversation
that burned 2-3 rounds confirming emptiness (now skipped with an "already
fully staffed" digest line — the Easter run spent ~12 of its 31 iterations
on exactly this).
