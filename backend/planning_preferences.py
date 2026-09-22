"""Shared interpretation of personal work patterns for scoring and tools."""

from datetime import date, timedelta


def vacation_dates_in_range(clinician, start: date, end: date) -> set[date]:
    """Distinct vacation dates in the half-open interval [start, end).

    Vacation entries are inclusive and may overlap. Clip before expanding so
    an old or long absence cannot slow down a short planning-range score.
    """
    days: set[date] = set()
    for vacation in clinician.vacations or []:
        try:
            first = max(start, date.fromisoformat(vacation.startISO))
            last = min(end - timedelta(days=1), date.fromisoformat(vacation.endISO))
        except (ValueError, TypeError, AttributeError):
            continue
        while first <= last:
            days.add(first)
            first += timedelta(days=1)
    return days


def daily_target_minutes(clinician, window=None):
    pattern = clinician.workPattern
    contract = clinician.workingHoursPerWeek
    if pattern and pattern.dailyHours is not None:
        target = round(pattern.dailyHours * 60)
    elif contract is not None and contract > 0:
        days = pattern.daysPerWeek if pattern and pattern.daysPerWeek else 5
        target = round(contract * 60 / days)
        if not pattern or not pattern.daysPerWeek:
            target = min(target, 600)  # preserve the legacy default
    else:
        target = 480
    explicit_pattern = pattern and (pattern.dailyHours is not None or pattern.daysPerWeek is not None
                                    or pattern.dailyHoursTolerance is not None)
    # A preferred clock-time window is a separate wish, not a request to
    # shorten an explicitly configured working day. Preserve legacy targets
    # when no explicit duration/workday pattern was configured.
    if window is not None and (window[0] == "mandatory" or not explicit_pattern):
        target = min(target, max(60, window[2]-window[1]))
    return max(60, target)


def daily_min_minutes(clinician, window=None):
    pattern = clinician.workPattern
    if pattern and pattern.dailyHoursTolerance is not None:
        return max(1, daily_target_minutes(clinician, window) - round(pattern.dailyHoursTolerance * 60))
    if pattern and (pattern.dailyHours is not None or pattern.daysPerWeek is not None):
        return max(1, daily_target_minutes(clinician, window)//2)
    if window is not None:
        return max(1, (window[2]-window[1])//2)
    contract = clinician.workingHoursPerWeek
    if contract is not None and contract > 0:
        return max(1, round(contract*60/5)//2)
    return None


def daily_comfort_minutes(clinician, window=None):
    pattern = clinician.workPattern
    tolerance = pattern.dailyHoursTolerance if pattern and pattern.dailyHoursTolerance is not None else 1
    return daily_target_minutes(clinician, window) + round(tolerance * 60)
