# Human Heuristic Shift Filling Strategy

## 1. Introduction

This document describes how a human expert would approach the shift scheduling problem in a systematic, algorithmic way. It serves as a reference for understanding human scheduling logic and as a potential alternative to the current constraint programming (CP-SAT) solver.

The current OR-Tools CP-SAT solver operates by formulating the entire scheduling problem as a constraint satisfaction problem with an objective function. While powerful, this approach can sometimes produce solutions that violate practical constraints or make assignments that a human expert would consider suboptimal. This often happens when the constraint formulation doesn't perfectly capture all real-world nuances or when the solver gets stuck in local optima.

The human approach described here is fundamentally different: it uses a **greedy, day-by-day heuristic** with backtracking. Rather than solving the entire week simultaneously, it fills one day at a time, prioritizing difficult-to-fill slots first, and retries with alternative choices when it gets stuck. This approach mirrors how an experienced scheduler would manually build a shift plan.

---

## 2. High-Level Overview

### Core Principles

1. **Day-by-Day Processing**: Process each day sequentially (Monday → Tuesday → ... → Sunday)
2. **Slot Prioritization**: Within each day, fill the hardest-to-fill slots first
3. **Doctor Balancing**: Prefer doctors who are behind on their yearly/weekly hour targets
4. **Consecutive Slot Assignment**: Once a doctor is assigned, try to give them consecutive slots at the same location
5. **Backtracking on Failure**: If a day can't be filled, backtrack and try alternative doctor assignments
6. **Respect Manual Assignments**: Pre-filled slots by experts are fixed and never changed

### Why This Works

This approach works because:
- **Criticality-first ordering** ensures that constrained slots (few eligible doctors) are filled before flexible ones
- **Balance-based ranking** naturally distributes work evenly across the team
- **Consecutive slot grouping** creates efficient shift blocks and respects continuity preferences
- **Backtracking** handles cases where early greedy choices lead to dead ends
- **Limited retries** prevent infinite loops while still exploring reasonable alternatives

---

## 3. Detailed Algorithm

### Phase 0: Initialization

**Input:**
- Weekly template with slots (times, locations, sections, required counts)
- List of clinicians with:
  - Contract hours (`workingHoursPerWeek`)
  - Eligible sections (qualifications, in priority order)
  - Working hours tolerance (`workingHoursToleranceHours`, default ±5 hours)
  - Preferred working times per weekday (optional: `startTime`, `endTime`, `requirement` = "none" | "preference" | "mandatory")
  - Vacation dates
  - Year-to-date hours worked
- Existing manual assignments (fixed, do not modify)
- Date range to schedule
- Configuration parameters:
  - `MAX_DAY_RETRIES` (suggested default: 5)
  - `ENFORCE_SAME_LOCATION_PER_DAY` (boolean, default: true)
  - `ENFORCE_CONTINUOUS_SHIFTS` (boolean, default: true)
  - On-call rest day settings (if enabled: section ID, days before/after)

**Pre-processing:**
1. Calculate each clinician's year-to-date hour deficit/surplus (relative to expected hours based on contract)
2. Mark all manually pre-filled slots as fixed
3. Count manual assignment hours toward clinicians' weekly/yearly totals

---

### Phase 0.5: Bottleneck Pre-Assignment

**Purpose:** Before the main day-by-day greedy algorithm, identify and assign **bottleneck slots** where only one doctor is eligible. This prevents flexible generalists from taking slots that specialists need.

**Problem being solved:**
- Dr. Brown can only do mammography (specialist)
- Dr. Johnson can do mammography OR MRI (generalist)
- Without this phase, greedy algorithm might assign Johnson to mammography, leaving no one for Brown's specialty
- Result: Brown sits idle while Johnson is overloaded

**Algorithm:**

```
bottleneck_assignments = []

FOR each date D in date_range (chronologically):
    REPEAT:
        found_bottleneck = false

        FOR each unfilled slot S on date D:
            eligible_doctors = FILTER_ELIGIBLE_DOCTORS(S, date D)

            IF COUNT(eligible_doctors) == 1:
                // BOTTLENECK! Only one doctor can fill this slot
                doctor = eligible_doctors[0]
                ASSIGN(doctor, slot S, date D)
                ADD assignment to bottleneck_assignments
                MARK assignment as "bottleneck" (preserved during backtracking)
                found_bottleneck = true
                BREAK  // Eligibility may have changed, recheck all slots

        IF NOT found_bottleneck:
            BREAK  // No more bottlenecks, proceed to main algorithm
```

**Key points:**
- Bottleneck assignments are treated like manual assignments (never removed during backtracking)
- After each bottleneck assignment, eligibility is rechecked (hours/overlaps may have changed)
- This phase only assigns slots where there's NO choice (exactly 1 eligible doctor)
- Ensures specialists get their work before generalists take it

---

### Phase 1: Day-by-Day Iteration

```
FOR each day D in date_range (Monday → Sunday):
    retry_count = 0
    day_solved = false

    WHILE retry_count < MAX_DAY_RETRIES AND NOT day_solved:
        result = TRY_FILL_DAY(D, retry_count)

        IF result == SUCCESS:
            day_solved = true
            COMMIT assignments for day D
            UPDATE clinicians' weekly/yearly hour counters
        ELSE:
            retry_count++
            IF retry_count < MAX_DAY_RETRIES:
                BACKTRACK: reset day D to manual assignments only
            ELSE:
                LOG warning: "Day D could not be fully filled after MAX_DAY_RETRIES attempts"
                MARK remaining slots as unfilled
                CONTINUE to next day
```

---

### Phase 2: Filling a Single Day (TRY_FILL_DAY)

**Step 2.1: Identify Unfilled Slots**

```
unfilled_slots = []

FOR each slot S in day D:
    IF slot S is NOT manually pre-filled:
        required_count = slot.requiredSlots
        current_assignments = COUNT assignments already made to slot S

        IF current_assignments < required_count:
            needed = required_count - current_assignments
            FOR i = 1 to needed:
                ADD slot S to unfilled_slots
```

**Step 2.2: Prioritize Slots by Criticality**

For each unfilled slot, calculate **criticality score** = number of doctors eligible for that slot.

```
FOR each slot S in unfilled_slots:
    eligible_doctors = FILTER_ELIGIBLE_DOCTORS(S, day D)
    S.criticality_score = COUNT(eligible_doctors)

SORT unfilled_slots by criticality_score (ascending)
// Lower score = fewer options = higher criticality = fill first

FOR slots with SAME criticality_score:
    SHUFFLE randomly to break ties
```

**Eligibility Criteria** (in `FILTER_ELIGIBLE_DOCTORS`):
1. **Qualification**: Doctor's eligible sections include the slot's section
2. **Vacation**: Doctor is NOT on vacation on day D
3. **Time overlap**: Doctor is NOT already assigned to an overlapping time slot on day D
4. **Preferred working times (mandatory)**: If doctor has `preferredWorkingTimes[weekday].requirement = "mandatory"`, the slot's time must fall within the specified window
5. **On-call rest days**: If on-call rest is enabled and doctor is assigned to on-call on nearby days (within configured offset), doctor is NOT eligible on rest days
6. **Same location per day** (if enabled): If doctor is already assigned to a different location on day D, they are NOT eligible for slots at other locations
7. **Hour limit**: Doctor's weekly hours (including this potential assignment) would not exceed `workingHoursPerWeek + workingHoursToleranceHours`

**Step 2.3: Fill Slots in Priority Order**

```
FOR each slot S in prioritized unfilled_slots:
    eligible_doctors = FILTER_ELIGIBLE_DOCTORS(S, day D)

    IF eligible_doctors is EMPTY:
        RETURN FAILURE  // Cannot fill this day, need to backtrack

    ranked_doctors = RANK_DOCTORS_BY_DEFICIT(eligible_doctors, retry_count)

    FOR each doctor DOC in ranked_doctors:
        // Try to assign DOC to slot S
        ASSIGN(DOC, slot S, day D)
        UPDATE DOC.current_week_hours

        // Try to fill consecutive slots at same location for DOC
        FILL_CONSECUTIVE_SLOTS(DOC, slot S, day D)

        BREAK  // Move to next unfilled slot
```

**Step 2.4: Rank Doctors by Multi-Criteria Priority**

```
FUNCTION RANK_DOCTORS_BY_DEFICIT(eligible_doctors, slot, retry_count):
    FOR each doctor DOC in eligible_doctors:
        // Primary criterion: current week filling percentage
        contract_hours = DOC.workingHoursPerWeek
        IF contract_hours > 0:
            current_week_percentage = DOC.current_week_hours / contract_hours
        ELSE:
            current_week_percentage = 0

        // Secondary criterion: year-to-date balance
        ytd_expected_hours = WEEKS_ELAPSED_THIS_YEAR × contract_hours
        ytd_actual_hours = DOC.year_to_date_hours
        ytd_deficit = ytd_expected_hours - ytd_actual_hours

        // Tertiary criterion: section preference (position in eligible sections list)
        section_priority = INDEX_OF(slot.section, DOC.eligible_sections)
        // Lower index = higher preference = better score

        // Quaternary criterion: preferred time window match
        time_preference_bonus = 0
        IF slot falls within DOC.preferredWorkingTimes[weekday] AND requirement = "preference":
            time_preference_bonus = 1  // Small bonus for matching preference

        DOC.priority_score = (
            current_week_percentage,
            -ytd_deficit,
            section_priority,
            -time_preference_bonus
        )

    SORT eligible_doctors by priority_score (ascending)
    // Lower values are better: fewer hours, higher deficit, higher section preference, better time match

    IF retry_count > 0:
        // On retry, skip the first (retry_count) doctors to try alternatives
        eligible_doctors = eligible_doctors[retry_count:]

    RETURN eligible_doctors
```

**Multi-level priority** (in order of importance):
1. **Current week %**: Prefer doctors with fewer hours this week (immediate fairness)
2. **YTD deficit**: Prefer doctors who are behind overall (long-term fairness)
3. **Section preference**: Prefer doctors for their preferred sections (satisfaction)
4. **Time preference**: Small bonus for matching preferred working times (work-life balance)

---

### Phase 3: Filling Consecutive Slots

Once a doctor is assigned to a slot, try to extend their shift by filling additional consecutive slots at the **same location**.

```
FUNCTION FILL_CONSECUTIVE_SLOTS(doctor, initial_slot, day):
    location = initial_slot.location
    end_time = initial_slot.endTime (with endDayOffset)

    // Check if doctor's working hours are already in "good range"
    IF doctor.current_week_hours >= (doctor.workingHoursPerWeek - doctor.workingHoursToleranceHours) AND
       doctor.current_week_hours <= (doctor.workingHoursPerWeek + doctor.workingHoursToleranceHours):
        RETURN  // Stop filling, doctor has enough hours

    // Look for next consecutive slot: same location, starts exactly when previous ends
    WHILE true:
        next_slot = FIND_SLOT_AT_LOCATION_STARTING_AT(location, end_time, day)

        IF next_slot is NULL:
            BREAK  // No consecutive slot exists

        IF next_slot is already filled:
            BREAK  // Consecutive chain ends

        IF doctor is NOT qualified for next_slot.section:
            BREAK  // Doctor cannot take this slot

        IF doctor.current_week_hours + next_slot.duration > (doctor.workingHoursPerWeek + doctor.workingHoursToleranceHours):
            BREAK  // Would exceed maximum allowed hours

        // Assign doctor to next_slot
        ASSIGN(doctor, next_slot, day)
        UPDATE doctor.current_week_hours

        // Update end_time for next iteration
        end_time = next_slot.endTime (with endDayOffset)

        // Check if doctor is now in "good range"
        IF doctor.current_week_hours >= (doctor.workingHoursPerWeek - doctor.workingHoursToleranceHours):
            BREAK  // Target hours reached, stop filling
```

**Consecutive Slot Rules:**
- **Same location**: Doctor stays at the same physical location
- **No time gap**: Next slot must start exactly when the previous ends (no breaks)
- **Different sections allowed**: Doctor can move between sections (e.g., MRI → CT) as long as they're qualified
- **Always check qualifications**: Every slot assignment verifies doctor eligibility (including preferred time windows if mandatory)
- **Respect hour limits**: Stop if doctor would exceed `workingHoursPerWeek + tolerance`
- **Target range**: Continue until doctor reaches `workingHoursPerWeek - tolerance`
- **Continuity enforcement**: If `ENFORCE_CONTINUOUS_SHIFTS` is enabled, doctors can have at most one continuous block per day (unless manual assignments already create multiple blocks)

---

### Phase 4: Backtracking Logic

When a day cannot be filled (some slot has no eligible doctors), the algorithm **backtracks** by trying alternative doctor choices for earlier slots.

```
FUNCTION TRY_FILL_DAY(day, retry_count):
    // Reset day to manual assignments only
    RESET_DAY_TO_MANUAL_ONLY(day)

    // On retry N, the RANK_DOCTORS_BY_DEFICIT function will skip the top N doctors
    // This effectively tries the "next best" doctor choice for each slot

    result = FILL_DAY_WITH_PRIORITIZED_SLOTS(day, retry_count)
    RETURN result
```

**Backtracking Strategy:**
- **Retry 0**: Try with the best-ranked doctors
- **Retry 1**: Skip the top-ranked doctor for each slot, try the 2nd best
- **Retry 2**: Skip top 2 doctors, try the 3rd best
- ...and so on up to `MAX_DAY_RETRIES`

This explores different solution paths by making different greedy choices at each slot.

**Failure Handling:**
- If all retries fail, mark remaining slots as unfilled
- Log a warning with details (which slots, how many retries)
- Continue to the next day (don't abort the entire week)

---

## 4. Key Concepts & Definitions

### Slot Criticality

**Definition**: The number of eligible doctors who can fill a slot on a specific day.

**Why it matters**: Slots with fewer eligible doctors are harder to fill. By filling critical slots first, we avoid "painting ourselves into a corner" where we've used up all eligible doctors on easier slots.

**Example**:
- Slot A (MRI Morning): 8 eligible doctors → criticality = 8
- Slot B (On-call Night): 2 eligible doctors → criticality = 2
- **Fill Slot B first** (more critical)

---

### Doctor Eligibility

A doctor is eligible for a slot if ALL of the following are true:

1. **Qualified**: Doctor's `qualifiedClassIds` includes the slot's `sectionId`
2. **Available**: Doctor is NOT on vacation on that day
3. **No conflict**: Doctor is NOT assigned to an overlapping time slot on that day
4. **Mandatory time window**: If doctor has `preferredWorkingTimes[weekday].requirement = "mandatory"`, the slot must fall within the specified `startTime`-`endTime` window
5. **On-call rest**: If on-call rest days are enabled and doctor has an on-call assignment within the configured window (days before/after), doctor is NOT eligible on those rest days
6. **Same location** (optional): If `ENFORCE_SAME_LOCATION_PER_DAY` is enabled and doctor is already assigned to a different location that day, they are NOT eligible
7. **Hour limit**: Assigning this slot would NOT push doctor over `workingHoursPerWeek + tolerance`

---

### Doctor Ranking (Priority)

Doctors are ranked by a **four-level priority**:

**Primary**: Current week hour percentage
- `current_week_percentage = current_week_hours / workingHoursPerWeek`
- Prefer doctors with **lower** percentage (fewer hours this week)

**Secondary**: Year-to-date hour deficit
- `ytd_deficit = (weeks_elapsed × workingHoursPerWeek) - year_to_date_hours`
- Prefer doctors with **higher** deficit (more behind overall)

**Tertiary**: Section preference
- Position of slot's section in doctor's eligible sections list
- Prefer doctors for whom this section is ranked higher in their preferences

**Quaternary**: Preferred time window
- Small bonus if slot falls within doctor's `preferredWorkingTimes[weekday]` when `requirement = "preference"`
- Encourages work-life balance without being a hard constraint

**Rationale**:
- Balances weekly workload (immediate fairness)
- Corrects long-term imbalances (annual fairness)
- Respects doctor preferences (satisfaction)
- Encourages preferred working times (work-life balance)

---

### Consecutive Slot Filling

Once a doctor is assigned to a slot, the algorithm attempts to **chain** additional slots for the same doctor at the same location.

**Benefits**:
- **Efficiency**: Reduces setup time, travel, context switching
- **Continuity**: Creates coherent shift blocks (e.g., 8am-4pm instead of scattered hours)
- **Fairness**: Brings doctors closer to their target weekly hours in one go

**Constraints**:
- Same location only (no travel between sites during a shift)
- Must be truly consecutive (no time gaps)
- Doctor must be qualified for each slot
- Stop when doctor reaches target hour range

---

### Manual Assignment Preservation

**Rule**: Any slot that was manually pre-filled by an expert user **MUST NOT** be changed by the algorithm.

**Implementation**:
- Manual assignments are marked as "fixed" during initialization
- These slots are excluded from `unfilled_slots` list
- Manual assignment hours count toward doctor's weekly/yearly totals
- When calculating eligibility for other slots, manual assignments create time conflicts

**Why**: Expert users may have domain knowledge (doctor preferences, special circumstances) that the algorithm cannot capture.

---

### Backtracking and Retry Limit

**Backtracking**: When a day cannot be filled, reset assignments for that day and try again with different doctor choices.

**Retry mechanism**: On retry N, skip the top N doctors in the ranking to explore alternative solution paths.

**Retry limit** (`MAX_DAY_RETRIES`): Maximum number of attempts before giving up on a day.
- **Suggested default**: 5
- **Too low**: May miss valid solutions
- **Too high**: Wastes computation time on infeasible days

**Failure mode**: If all retries fail, mark remaining slots as unfilled and continue to next day.

---

## 5. Comparison with Current OR-Tools CP-SAT Solver

| Aspect | Human Heuristic (This Document) | OR-Tools CP-SAT Solver |
|--------|----------------------------------|-------------------------|
| **Approach** | Greedy with backtracking | Constraint programming |
| **Scope** | Day-by-day | Entire week simultaneously |
| **Optimality** | Not guaranteed, "good enough" | Searches for optimal solution |
| **Execution** | Fast, deterministic (with fixed seed) | Slower, can vary by run |
| **Failure handling** | Partial solutions, continues | May fail or timeout |
| **Transparency** | Clear decision logic | "Black box" optimization |
| **Manual overrides** | Naturally preserved | Requires hard constraints |
| **Hour balancing** | Explicit 4-level priority | Soft constraint in objective |
| **Consecutive shifts** | Built-in via chaining | Enforced via continuity constraints |
| **Preferred times** | Integrated in eligibility + ranking | Hard (mandatory) + soft (preference) |
| **Section preference** | Explicit tertiary criterion | Soft constraint in objective |

### When to Use Each Approach

**Human Heuristic (Greedy)**:
- When you need **predictable, fast results**
- When **transparency** of decisions is important
- When partial solutions are acceptable (some days may have unfilled slots)
- When the schedule has many manual overrides

**OR-Tools CP-SAT**:
- When you need **globally optimal solutions**
- When you can afford longer solve times
- When all constraints can be formulated mathematically
- When you want to explore trade-offs (e.g., by adjusting objective weights)

### Hybrid Approach

A practical system might:
1. Try CP-SAT first with a reasonable timeout (e.g., 60 seconds)
2. If CP-SAT fails or times out, fall back to the human heuristic
3. Present both solutions to the user and let them choose

---

## 6. Implementation Considerations

### Configuration Parameters

```python
class HeuristicSolverConfig:
    max_day_retries: int = 5
    # Maximum attempts to fill a single day before giving up

    enable_consecutive_filling: bool = True
    # Whether to chain consecutive slots for the same doctor

    enforce_same_location_per_day: bool = True
    # Whether to prevent mixing locations on the same day per clinician

    enforce_continuous_shifts: bool = True
    # Whether to limit each clinician to one continuous work block per day

    on_call_rest_enabled: bool = False
    # Whether to enforce rest days before/after on-call shifts

    on_call_section_id: str = "on-call"
    # Section ID that triggers rest day requirements

    on_call_rest_days_before: int = 1
    # Number of rest days required before on-call

    on_call_rest_days_after: int = 1
    # Number of rest days required after on-call

    random_seed: int = 42
    # For reproducible tie-breaking when slots have same criticality

    respect_manual_assignments: bool = True
    # Whether to treat manual assignments as fixed (should always be True)
```

### Edge Cases

**1. Zero contract hours**: What if `doctor.workingHoursPerWeek` is 0 or missing?
- **Solution**: Treat as "no preference," rank such doctors last

**2. Vacation during solve range**: Should vacation days count toward yearly hours?
- **Solution**: No, vacation days do NOT count as worked hours

**3. On-call rest days**: Are rest days enforced symmetrically or only in the solve range?
- **Solution**: Check if on-call assignments exist within the configured window (before/after), but only enforce rest within the date range being solved. Log warnings for boundary conflicts.

**4. Preferred time preferences**: How strongly should "preference" (non-mandatory) time windows influence ranking?
- **Solution**: Use as a quaternary (4th-level) tie-breaker with small weight. Primary factors (hour balancing) remain dominant.

**5. Tie-breaking**: Multiple doctors with identical priority scores?
- **Solution**: Use random shuffle with fixed seed for reproducibility

**6. Partial week**: Solving mid-week (e.g., Wednesday-Friday)?
- **Solution**: Year-to-date calculations should include previous days of the current week

**7. Location changes**: Doctor assigned to different locations on different days?
- **Solution**: Allowed between days (unless `enforce_same_location_per_day` is enabled), but NOT within a consecutive shift chain

**8. All doctors at maximum hours**: What if every eligible doctor has reached hour limit?
- **Solution**: Slot remains unfilled, logged as a warning

**9. Infinite loop risk**: Consecutive slot filling could theoretically loop?
- **Solution**: Each iteration consumes a slot from the unfilled list, guaranteed termination

**10. Preferred working times - mandatory**: What if no doctors can satisfy a mandatory time window?
- **Solution**: Slot remains unfilled, logged as critical error (requires manual intervention or relaxed constraints)

---

## 7. Example Walkthrough

Let's walk through a simplified example to illustrate the algorithm.

### Setup

**Day**: Monday, January 6, 2026

**Slots**:
- Slot A: MRI Morning (08:00-12:00, 4 hours, Location: Berlin)
- Slot B: CT Morning (08:00-12:00, 4 hours, Location: Berlin)
- Slot C: On-call Night (20:00-08:00+1d, 12 hours, Location: Berlin)
- All slots require 1 doctor each

**Doctors**:
- Dr. Alice: Qualified for MRI, CT, On-call | Current week: 0h | YTD deficit: +8h (behind)
- Dr. Bob: Qualified for MRI, CT | Current week: 0h | YTD deficit: -4h (ahead)
- Dr. Carol: Qualified for On-call only | Current week: 0h | YTD deficit: +2h (behind)

**Contract hours**: All doctors have 40h/week, ±5h tolerance

### Execution

**Step 1**: Identify unfilled slots
- Unfilled: Slot A, Slot B, Slot C

**Step 2**: Calculate criticality
- Slot A (MRI): eligible = [Alice, Bob] → criticality = 2
- Slot B (CT): eligible = [Alice, Bob] → criticality = 2
- Slot C (On-call): eligible = [Alice, Carol] → criticality = 2
- All tied at 2, **shuffle randomly**: let's say order becomes [C, A, B]

**Step 3**: Fill Slot C (On-call) first
- Eligible: [Alice, Carol]
- Rank by deficit:
  - Alice: week%=0%, YTD deficit=+8h
  - Carol: week%=0%, YTD deficit=+2h
  - **Alice ranks first** (higher YTD deficit)
- **Assign Alice to Slot C** (20:00-08:00+1d, 12 hours)
- Alice now: current_week_hours = 12h
- Try consecutive slots? No slots start at 08:00 on Tuesday in this example

**Step 4**: Fill Slot A (MRI Morning)
- Eligible: [Bob] (Alice has time conflict: 08:00 overlaps with her on-call)
- **Assign Bob to Slot A** (08:00-12:00, 4 hours)
- Bob now: current_week_hours = 4h
- Try consecutive slots? Check if any slot starts at 12:00...

**Step 5**: Fill Slot B (CT Morning)
- Wait! Bob was assigned to Slot A (08:00-12:00), and Slot B is also 08:00-12:00 (same time)
- This is a **time conflict**, Bob cannot take Slot B
- Eligible: [] (Alice conflicts, Bob conflicts)
- **FAILURE**: Cannot fill Slot B

**Step 6**: Backtrack (retry_count = 1)
- Reset Monday to manual assignments only (none in this case)
- Retry with skip=1 (skip first-ranked doctor for each slot)

**Retry 1, Step 3**: Fill Slot C
- Eligible: [Alice, Carol], ranked: [Alice, Carol]
- Skip first (Alice), try **Carol**
- **Assign Carol to Slot C**
- Carol now: current_week_hours = 12h

**Retry 1, Step 4**: Fill Slot A (MRI)
- Eligible: [Alice, Bob], ranked: [Alice, Bob] (Alice has higher YTD deficit)
- Skip first (Alice), try **Bob**
- **Assign Bob to Slot A**
- Bob now: current_week_hours = 4h

**Retry 1, Step 5**: Fill Slot B (CT)
- Eligible: [Alice, Bob], ranked: [Alice, Bob]
- Skip first (Alice), try **Bob**
- But Bob is already assigned to Slot A (08:00-12:00), time conflict!
- **Eligible now: [Alice]** (Bob conflicts)
- **Assign Alice to Slot B**
- Alice now: current_week_hours = 4h

**Success!** Monday is fully filled:
- Slot A (MRI): Bob
- Slot B (CT): Alice
- Slot C (On-call): Carol

### Key Takeaways from Example

1. **Criticality alone isn't enough**: All slots had same criticality, so tie-breaking mattered
2. **Backtracking found a solution**: First attempt failed due to time conflicts, retry succeeded
3. **Ranking by YTD deficit**: Alice was preferred over Bob initially due to higher deficit
4. **Time conflict handling**: Algorithm correctly detected overlaps and marked doctors ineligible

---

## 8. Pseudocode Summary

For implementers, here's a concise pseudocode outline:

```python
def solve_week(date_range, clinicians, slots, manual_assignments, config):
    initialize_clinicians(clinicians)  # Load YTD hours, contract hours, etc.

    for day in date_range:
        day_solved = False
        for retry in range(config.max_day_retries):
            reset_day_to_manual_only(day)

            unfilled_slots = get_unfilled_slots(day, slots, manual_assignments)
            prioritized_slots = prioritize_by_criticality(unfilled_slots, day, clinicians)

            success = True
            for slot in prioritized_slots:
                eligible = filter_eligible_doctors(slot, day, clinicians)
                if not eligible:
                    success = False
                    break

                ranked = rank_doctors_by_deficit(eligible, retry)
                doctor = ranked[0]

                assign(doctor, slot, day)
                if config.enable_consecutive_filling:
                    fill_consecutive_slots(doctor, slot, day)

            if success:
                commit_day(day)
                day_solved = True
                break

        if not day_solved:
            log_warning(f"Day {day} could not be fully filled")
            commit_partial_day(day)

    return get_all_assignments()


def rank_doctors_by_deficit(doctors, slot, retry_skip_count):
    for doc in doctors:
        week_pct = doc.current_week_hours / doc.workingHoursPerWeek
        ytd_deficit = (weeks_elapsed() * doc.workingHoursPerWeek) - doc.ytd_hours
        section_priority = doc.eligible_sections.index(slot.section)
        time_bonus = 1 if slot_in_preferred_time_window(doc, slot) else 0
        doc.priority = (week_pct, -ytd_deficit, section_priority, -time_bonus)

    sorted_doctors = sort(doctors, key=lambda d: d.priority)
    return sorted_doctors[retry_skip_count:]  # Skip first N on retries


def fill_consecutive_slots(doctor, initial_slot, day):
    location = initial_slot.location
    end_time = initial_slot.end_time

    while doctor.current_week_hours < doctor.target_hours:
        next_slot = find_slot_starting_at(location, end_time, day)
        if not next_slot or next_slot.is_filled():
            break

        if not doctor.is_qualified_for(next_slot.section):
            break

        if doctor.would_exceed_max_hours(next_slot):
            break

        assign(doctor, next_slot, day)
        end_time = next_slot.end_time

    return
```

---

## 9. Requirements Coverage Checklist

This section verifies that the heuristic solver covers all requirements from the current CP-SAT solver.

### Hard Constraints (Must-Have)

| Requirement | Covered? | Implementation |
|-------------|----------|----------------|
| **Qualification** | ✅ | Eligibility filter (criterion #1) |
| **Vacation override** | ✅ | Eligibility filter (criterion #2) |
| **Time overlap prevention** | ✅ | Eligibility filter (criterion #3) |
| **Mandatory time windows** | ✅ | Eligibility filter (criterion #4) |
| **On-call rest days** | ✅ | Eligibility filter (criterion #5) |
| **Same location per day** | ✅ | Eligibility filter (criterion #6), configurable |
| **Working hour limits** | ✅ | Eligibility filter (criterion #7) |
| **Manual assignment preservation** | ✅ | Phase 0 initialization, fixed slots |
| **Continuity enforcement** | ✅ | Consecutive slot filling with block limit, configurable |

### Soft Objectives (Optimizations)

| Objective | Covered? | Implementation |
|-----------|----------|----------------|
| **Maximize coverage** | ✅ | Implicit: fill all required slots before giving up |
| **Minimize slack** | ✅ | Implicit: prioritize critical slots |
| **Balance working hours** | ✅ | Primary ranking criterion (current week %) |
| **Year-to-date fairness** | ✅ | Secondary ranking criterion (YTD deficit) |
| **Section preference** | ✅ | Tertiary ranking criterion |
| **Preferred time windows** | ✅ | Quaternary ranking criterion (preference mode) |
| **Slot priority** | ✅ | Criticality-based ordering |
| **Distribute all assignments** | ⚠️ | Not explicitly handled (greedy approach fills required slots only) |

### Key Differences from CP-SAT

1. **Distribute All mode**: The heuristic focuses on filling required slots efficiently. To simulate "distribute all," increase required counts or reduce hour limits.
2. **Global optimality**: CP-SAT seeks the globally optimal solution; the heuristic finds a "good enough" solution quickly through greedy choices.
3. **Backtracking scope**: The heuristic backtracks per-day; CP-SAT can explore week-wide alternatives.

### Conclusion on Requirements

The heuristic solver **covers all hard constraints** and **most soft objectives** from the CP-SAT solver. The main trade-off is **speed vs. optimality**: the heuristic is faster and more transparent, while CP-SAT explores more solution combinations.

---

## 10. Conclusion

This document captures the human expert approach to shift scheduling: a **greedy, prioritized, backtracking heuristic** that balances fairness, efficiency, and practical constraints.

### Strengths

- **Intuitive**: Mirrors how human schedulers actually work
- **Transparent**: Every assignment decision has a clear rationale
- **Robust**: Handles partial solutions gracefully
- **Fair**: Explicitly balances weekly and yearly hour distribution

### Limitations

- **Not optimal**: May miss better solutions that require non-greedy choices
- **Relies on retries**: Backtracking can be slow if many retries are needed
- **Limited look-ahead**: Doesn't consider impact on future days

### Next Steps

To implement this as a solver:
1. Translate pseudocode to Python (see Section 8)
2. Add comprehensive logging for transparency
3. Run side-by-side tests against OR-Tools CP-SAT
4. Measure: solve time, solution quality, fill rate
5. Consider hybrid approach (try CP-SAT first, fall back to heuristic)

### Reference Implementation

For a reference implementation, see: (to be added when implemented)

---

**Document Version**: 1.0
**Last Updated**: 2026-02-06
**Author**: Daniel Truhn (based on domain expertise)
