"""Tests for iCal generation.

These tests verify that the iCal generator correctly:
- Escapes special characters per RFC 5545
- Folds long lines per RFC 5545 (75 octets)
- Formats UTC date-times correctly
- Generates valid iCal format
- Only includes section assignments (no pool rows)
- Filters out vacation days
- Sends shift times as UTC instants of the plan's wall clock (DST included)
- Names calendars and files without the account's login name
"""

from datetime import datetime, timezone

import pytest

from backend.ical import (
    _escape_text,
    _fold_ical_line,
    _format_utc,
    generate_ics,
    ical_calendar_name,
    ical_file_name,
)


class TestEscapeText:
    """Tests for _escape_text() function."""

    def test_escapes_backslash(self) -> None:
        """Backslashes should be escaped."""
        assert _escape_text("a\\b") == "a\\\\b"

    def test_escapes_comma(self) -> None:
        """Commas should be escaped."""
        assert _escape_text("a,b") == "a\\,b"

    def test_escapes_semicolon(self) -> None:
        """Semicolons should be escaped."""
        assert _escape_text("a;b") == "a\\;b"

    def test_converts_newlines(self) -> None:
        """Newlines should be converted to \\n."""
        assert _escape_text("a\nb") == "a\\nb"

    def test_converts_carriage_return_newline(self) -> None:
        """CRLF should be converted to \\n."""
        assert _escape_text("a\r\nb") == "a\\nb"

    def test_converts_carriage_return(self) -> None:
        """CR should be converted to \\n."""
        assert _escape_text("a\rb") == "a\\nb"

    def test_handles_multiple_special_chars(self) -> None:
        """Multiple special characters should all be escaped."""
        assert _escape_text("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"


class TestFoldIcalLine:
    """Tests for _fold_ical_line() function per RFC 5545."""

    def test_short_line_unchanged(self) -> None:
        """Lines under 75 octets should not be folded."""
        line = "SUMMARY:Short line"
        assert _fold_ical_line(line) == line

    def test_folds_long_line(self) -> None:
        """Lines over 75 octets should be folded with CRLF+space."""
        line = "X" * 100
        result = _fold_ical_line(line)
        # Should contain fold marker
        assert "\r\n " in result
        # First segment should be 75 chars
        first_segment = result.split("\r\n ")[0]
        assert len(first_segment) == 75

    def test_fold_preserves_content(self) -> None:
        """Folded content should be recoverable by removing fold markers."""
        original = "X" * 200
        folded = _fold_ical_line(original)
        # Unfold by removing CRLF+space
        unfolded = folded.replace("\r\n ", "")
        assert unfolded == original

    def test_handles_unicode(self) -> None:
        """Folding should respect UTF-8 byte length, not character count."""
        # Unicode characters can be 2-4 bytes
        line = "SUMMARY:" + "ü" * 50  # ü is 2 bytes in UTF-8
        result = _fold_ical_line(line)
        # Should not cut in the middle of a multi-byte character
        for segment in result.split("\r\n "):
            # Each segment should be valid UTF-8
            segment.encode("utf-8")


    def test_fold_boundary_at_75_octets(self) -> None:
        """Exactly 75 octets stays one line; 76 folds, also with multi-byte chars."""
        assert _fold_ical_line("X" * 75) == "X" * 75
        assert _fold_ical_line("X" * 74 + "ü") == "X" * 74 + "\r\n ü"
        assert _fold_ical_line("X" * 73 + "ü") == "X" * 73 + "ü"
        folded = _fold_ical_line("X" * 76)
        assert folded == "X" * 75 + "\r\n X"


class TestFormatUtc:
    """Tests for _format_utc() function."""

    def test_formats_utc_datetime(self) -> None:
        """Should format datetime as YYYYMMDDTHHMMSSz."""
        dt = datetime(2026, 1, 5, 14, 30, 0, tzinfo=timezone.utc)
        result = _format_utc(dt)
        assert result == "20260105T143000Z"

    def test_converts_to_utc(self) -> None:
        """Non-UTC datetimes should be converted to UTC."""
        from datetime import timedelta

        # Create a datetime in UTC+1
        tz_plus_one = timezone(timedelta(hours=1))
        dt = datetime(2026, 1, 5, 15, 30, 0, tzinfo=tz_plus_one)
        result = _format_utc(dt)
        # Should be converted to UTC (14:30)
        assert result == "20260105T143000Z"

    def test_strips_microseconds(self) -> None:
        """Microseconds should be stripped."""
        dt = datetime(2026, 1, 5, 14, 30, 0, 123456, tzinfo=timezone.utc)
        result = _format_utc(dt)
        assert result == "20260105T143000Z"


class TestGenerateIcs:
    """Tests for generate_ics() function."""

    def _make_test_state(self, assignments=None, published=True):
        """Create a minimal valid app state for testing."""
        return {
            "rows": [
                {
                    "id": "section-a",
                    "name": "MRI",
                    "kind": "class",
                    "dotColorClass": "bg-slate-400",
                },
                {
                    "id": "pool-rest-day",
                    "name": "Rest Day",
                    "kind": "pool",
                    "dotColorClass": "bg-slate-200",
                },
            ],
            "clinicians": [
                {
                    "id": "clin-1",
                    "name": "Dr. Alice",
                    "qualifiedClassIds": ["section-a"],
                    "vacations": [],
                },
            ],
            "assignments": assignments or [],
            "weeklyTemplate": {
                "version": 4,
                "blocks": [
                    {
                        "id": "block-a",
                        "sectionId": "section-a",
                        "requiredSlots": 1,
                    }
                ],
                "locations": [
                    {
                        "locationId": "loc-default",
                        "rowBands": [{"id": "row-1", "label": "Row 1", "order": 1}],
                        "colBands": [{"id": "col-mon-1", "label": "", "order": 1, "dayType": "mon"}],
                        "slots": [
                            {
                                "id": "slot-a",
                                "locationId": "loc-default",
                                "rowBandId": "row-1",
                                "colBandId": "col-mon-1",
                                "blockId": "block-a",
                                "requiredSlots": 1,
                            }
                        ],
                    }
                ],
            },
            "publishedWeekStartISOs": ["2026-01-05"] if published else [],
        }

    def test_generates_valid_ical_format(self) -> None:
        """Generated iCal should have correct structure."""
        state = self._make_test_state(
            assignments=[
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                }
            ]
        )
        result = generate_ics(state, ["2026-01-05"], "Test Calendar")

        assert result.startswith("BEGIN:VCALENDAR\r\n")
        assert "END:VCALENDAR\r\n" in result
        assert "VERSION:2.0\r\n" in result
        assert "PRODID:-//ShiftSchedule//EN\r\n" in result

    def test_includes_calendar_name(self) -> None:
        """Calendar name should be in X-WR-CALNAME header."""
        state = self._make_test_state()
        result = generate_ics(state, [], "My Schedule")
        assert "X-WR-CALNAME:My Schedule\r\n" in result

    def test_only_includes_section_assignments(self) -> None:
        """Only assignments to class rows should be included, not pools."""
        state = self._make_test_state(
            assignments=[
                # Class assignment - should be included
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                },
                # Pool assignment - should be excluded
                {
                    "id": "a2",
                    "rowId": "pool-rest-day",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                },
            ]
        )
        result = generate_ics(state, ["2026-01-05"], "Test Calendar")

        # Should have one VEVENT (the class assignment)
        assert result.count("BEGIN:VEVENT") == 1
        # Pool row shouldn't be referenced
        assert "pool-rest-day" not in result

    def test_filters_vacation_days(self) -> None:
        """Assignments during vacation should be excluded."""
        state = {
            "rows": [
                {
                    "id": "section-a",
                    "name": "MRI",
                    "kind": "class",
                }
            ],
            "clinicians": [
                {
                    "id": "clin-1",
                    "name": "Dr. Alice",
                    "qualifiedClassIds": ["section-a"],
                    "vacations": [
                        {
                            "id": "v1",
                            "startISO": "2026-01-05",
                            "endISO": "2026-01-10",
                        }
                    ],
                },
            ],
            "assignments": [
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-07",  # During vacation
                    "clinicianId": "clin-1",
                }
            ],
            "weeklyTemplate": {
                "version": 4,
                "blocks": [{"id": "block-a", "sectionId": "section-a"}],
                "locations": [
                    {
                        "locationId": "loc-default",
                        "slots": [{"id": "slot-a", "blockId": "block-a"}],
                    }
                ],
            },
        }
        result = generate_ics(state, ["2026-01-05"], "Test Calendar")

        # No VEVENTs should be generated (vacation filters them)
        assert "BEGIN:VEVENT" not in result

    def test_unpublished_weeks_excluded(self) -> None:
        """Assignments in unpublished weeks should be excluded."""
        state = self._make_test_state(
            assignments=[
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                }
            ]
        )
        # Empty published weeks list
        result = generate_ics(state, [], "Test Calendar")

        # No VEVENTs should be generated
        assert "BEGIN:VEVENT" not in result

    def test_published_weeks_included(self) -> None:
        """Assignments in published weeks should be included."""
        state = self._make_test_state(
            assignments=[
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                }
            ]
        )
        result = generate_ics(state, ["2026-01-05"], "Test Calendar")

        # One VEVENT should be generated
        assert result.count("BEGIN:VEVENT") == 1

    def test_event_contains_summary(self) -> None:
        """Events should have SUMMARY with row name and clinician."""
        state = self._make_test_state(
            assignments=[
                {
                    "id": "a1",
                    "rowId": "slot-a",
                    "dateISO": "2026-01-05",
                    "clinicianId": "clin-1",
                }
            ]
        )
        result = generate_ics(state, ["2026-01-05"], "Test Calendar")

        # Should contain clinician name and row name
        assert "Dr. Alice" in result
        assert "MRI" in result

    def test_clinician_filter(self) -> None:
        """When clinician_id is specified, only their events should be included."""
        state = {
            "rows": [{"id": "section-a", "name": "MRI", "kind": "class"}],
            "clinicians": [
                {"id": "clin-1", "name": "Dr. Alice", "vacations": []},
                {"id": "clin-2", "name": "Dr. Bob", "vacations": []},
            ],
            "assignments": [
                {"id": "a1", "rowId": "slot-a", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
                {"id": "a2", "rowId": "slot-a", "dateISO": "2026-01-06", "clinicianId": "clin-2"},
            ],
            "weeklyTemplate": {
                "version": 4,
                "blocks": [{"id": "block-a", "sectionId": "section-a"}],
                "locations": [{"locationId": "loc-default", "slots": [{"id": "slot-a", "blockId": "block-a"}]}],
            },
        }
        result = generate_ics(state, ["2026-01-05"], "Test", clinician_id="clin-1")

        # Only Dr. Alice's event should be included
        assert result.count("BEGIN:VEVENT") == 1
        assert "Dr. Alice" in result
        assert "Dr. Bob" not in result


    def _single_event_ics(
        self, slot_extra=None, clinician_id="clin-1", date_iso="2026-01-05", country=None
    ):
        state = self._make_test_state(assignments=[
            {"id": "a1", "rowId": "slot-a", "dateISO": date_iso, "clinicianId": clinician_id},
        ])
        state["weeklyTemplate"]["locations"][0]["slots"][0].update(slot_extra or {})
        if country is not None:
            state["holidayCountry"] = country
        week_start = datetime.fromisoformat(date_iso).date()
        week_start = week_start.fromordinal(week_start.toordinal() - week_start.weekday())
        return generate_ics(state, [week_start.isoformat()], "Test Calendar")

    @staticmethod
    def _times(ics: str) -> list[str]:
        return [line for line in ics.split("\r\n") if line.startswith(("DTSTART", "DTEND"))]

    @pytest.mark.parametrize("slot_extra", [
        {"endDayOffset": 2},
        {"startTime": "08:00", "endDayOffset": 1},
        {"startTime": "08:00", "endTime": "8 Uhr"},
        # Ends at or before its start: the team grid shows no time either.
        {"startTime": "16:00", "endTime": "00:00", "endDayOffset": 0},
    ])
    def test_shift_without_usable_times_is_an_all_day_event_on_its_day(self, slot_extra) -> None:
        result = self._single_event_ics(slot_extra)
        assert self._times(result) == ["DTSTART;VALUE=DATE:20260105", "DTEND;VALUE=DATE:20260106"]

    def test_timed_shift_is_sent_as_utc_from_the_plans_wall_clock(self) -> None:
        result = self._single_event_ics({"startTime": "08:00", "endTime": "16:30"})
        # 2026-01-05 is winter time in Berlin (UTC+1).
        assert self._times(result) == ["DTSTART:20260105T070000Z", "DTEND:20260105T153000Z"]
        assert "X-WR-TIMEZONE:Europe/Berlin\r\n" in result

    @pytest.mark.parametrize("date_iso,slot_extra,expected,hours", [
        # 16:00-24:00 ends at midnight and does not fill the next day.
        ("2026-11-02", {"startTime": "16:00", "endTime": "00:00", "endDayOffset": 1},
         ["DTSTART:20261102T150000Z", "DTEND:20261102T230000Z"], 8),
        # Night across the October change: clocks go back, 13 real hours.
        ("2026-10-24", {"startTime": "20:00", "endTime": "08:00", "endDayOffset": 1},
         ["DTSTART:20261024T180000Z", "DTEND:20261025T070000Z"], 13),
        # Night across the March change: clocks go forward, 11 real hours.
        ("2026-03-28", {"startTime": "20:00", "endTime": "08:00", "endDayOffset": 1},
         ["DTSTART:20260328T190000Z", "DTEND:20260329T060000Z"], 11),
        # Weekend duty Fri 18:00 to Sun 18:00 across the October change.
        ("2026-10-23", {"startTime": "18:00", "endTime": "18:00", "endDayOffset": 2},
         ["DTSTART:20261023T160000Z", "DTEND:20261025T170000Z"], 49),
        # endDayOffset is capped at 3 days, like the grid.
        ("2026-01-05", {"startTime": "08:00", "endTime": "08:00", "endDayOffset": 9},
         ["DTSTART:20260105T070000Z", "DTEND:20260108T070000Z"], 72),
    ])
    def test_overnight_and_dst_shifts_end_at_their_real_end(self, date_iso, slot_extra, expected, hours) -> None:
        result = self._single_event_ics(slot_extra, date_iso=date_iso)
        times = self._times(result)
        assert times == expected
        start, end = (datetime.strptime(t.split(":")[1], "%Y%m%dT%H%M%SZ") for t in times)
        assert (end - start).total_seconds() == hours * 3600

    @pytest.mark.parametrize("country,date_iso,expected", [
        ("GB", "2026-03-28", ["DTSTART:20260328T200000Z", "DTEND:20260329T070000Z"]),
        ("GB", "2026-10-24", ["DTSTART:20261024T190000Z", "DTEND:20261025T080000Z"]),
        # No DST in Moscow: both nights last 12 hours.
        ("RU", "2026-03-28", ["DTSTART:20260328T170000Z", "DTEND:20260329T050000Z"]),
        ("RU", "2026-10-24", ["DTSTART:20261024T170000Z", "DTEND:20261025T050000Z"]),
        ("fr", "2026-10-24", ["DTSTART:20261024T180000Z", "DTEND:20261025T070000Z"]),
        # Unknown or missing country: Europe/Berlin.
        ("XX", "2026-03-28", ["DTSTART:20260328T190000Z", "DTEND:20260329T060000Z"]),
    ])
    def test_time_zone_follows_the_holiday_country(self, country, date_iso, expected) -> None:
        night = {"startTime": "20:00", "endTime": "08:00", "endDayOffset": 1}
        assert self._times(self._single_event_ics(night, date_iso=date_iso, country=country)) == expected

    @pytest.mark.parametrize("date_iso,slot_extra,expected", [
        # 02:30 does not exist on 2026-03-29; like 03:30 it reads as 01:30 UTC,
        # so the shift has no real duration and gets no DTEND.
        ("2026-03-29", {"startTime": "02:30", "endTime": "03:30"}, ["DTSTART:20260329T013000Z"]),
        ("2026-03-29", {"startTime": "02:00", "endTime": "04:00"},
         ["DTSTART:20260329T010000Z", "DTEND:20260329T020000Z"]),
        # 02:30 exists twice on 2026-10-25: the first (summer time) one counts.
        ("2026-10-25", {"startTime": "02:30", "endTime": "03:30"},
         ["DTSTART:20261025T003000Z", "DTEND:20261025T023000Z"]),
    ])
    def test_nonexistent_and_ambiguous_local_times_use_the_offset_before_the_change(
        self, date_iso, slot_extra, expected
    ) -> None:
        assert self._times(self._single_event_ics(slot_extra, date_iso=date_iso)) == expected

    def test_events_are_ordered_by_start(self) -> None:
        state = self._make_test_state(assignments=[
            {"id": "late", "rowId": "slot-late", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
            {"id": "next-day", "rowId": "slot-a", "dateISO": "2026-01-06", "clinicianId": "clin-1"},
            {"id": "early", "rowId": "slot-a", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
            {"id": "all-day", "rowId": "slot-untimed", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
        ])
        slots = state["weeklyTemplate"]["locations"][0]["slots"]
        slots[0].update({"startTime": "07:00", "endTime": "12:00"})
        slots.append({**slots[0], "id": "slot-late", "startTime": "13:00", "endTime": "18:00"})
        slots.append({"id": "slot-untimed", "blockId": "block-a"})
        result = generate_ics(state, ["2026-01-05"], "Test")
        uids = [line[4:] for line in result.split("\r\n") if line.startswith("UID:")]
        assert uids == [
            "all-day@shiftschedule", "early@shiftschedule", "late@shiftschedule", "next-day@shiftschedule",
        ]

    def test_skips_assignments_of_deleted_clinicians(self) -> None:
        result = self._single_event_ics(clinician_id="ghost")
        assert "BEGIN:VEVENT" not in result
        assert "ghost" not in result


class TestNames:
    """Calendar and file names, identical to the download (src/lib/ical.ts)."""

    def test_calendar_names_never_use_the_account(self) -> None:
        assert ical_calendar_name() == "Shift Planner – All people"
        assert ical_calendar_name({"id": "c1", "name": "Müller, Jörg"}) == "Shift Planner – Müller, Jörg"
        assert ical_calendar_name({"id": "c1", "name": ""}) == "Shift Planner – c1"

    # Same cases as src/lib/ical.test.ts.
    @pytest.mark.parametrize("name,person_id,expected", [
        ("Müller, Jörg; Dr.", "c1", "shift-planner-mueller-joerg-dr.ics"),
        ("Zoë Ångström", "c2", "shift-planner-zoe-angstroem.ics"),
        ("Björn Ødegård", "c2", "shift-planner-bjoern-oedegard.ics"),
        ("Zoë O'Brien-Łukasiewicz", "c2", "shift-planner-zoe-obrien-lukasiewicz.ics"),
        ("Anne-Sophie Lefèvre-Brückner", "c3", "shift-planner-anne-sophie-lefevre-brueckner.ics"),
        ("GROẞE Straße", "c4", "shift-planner-grosse-strasse.ics"),
        ("李小龍", "c5", "shift-planner-c5.ics"),
        ("Emoji 🩺 Ärztin", "c6", "shift-planner-emoji-aerztin.ics"),
        ("李小龍\r\nZeile 2", "c7", "shift-planner-zeile-2.ics"),
        ("  Ünal\tÖzdemir  ", "c8", "shift-planner-uenal-oezdemir.ics"),
        ("🩺", "李", "shift-planner-person.ics"),
    ])
    def test_file_names_are_transliterated_ascii(self, name, person_id, expected) -> None:
        assert ical_file_name({"id": person_id, "name": name}) == expected

    def test_all_people_file_name(self) -> None:
        assert ical_file_name() == "shift-planner-all.ics"


class TestIcalPoolNeverReferenced:
    """Regression tests ensuring pools are never in iCal output."""

    def test_no_deprecated_pool_in_output(self) -> None:
        """Deprecated pool IDs should never appear in iCal output."""
        state = {
            "rows": [
                {"id": "section-a", "name": "MRI", "kind": "class"},
                {"id": "pool-not-allocated", "name": "Distribution Pool", "kind": "pool"},
                {"id": "pool-manual", "name": "Reserve Pool", "kind": "pool"},
            ],
            "clinicians": [{"id": "clin-1", "name": "Dr. Alice", "vacations": []}],
            "assignments": [
                {"id": "a1", "rowId": "pool-not-allocated", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
                {"id": "a2", "rowId": "pool-manual", "dateISO": "2026-01-05", "clinicianId": "clin-1"},
            ],
            "weeklyTemplate": {"version": 4, "blocks": [], "locations": []},
        }
        result = generate_ics(state, ["2026-01-05"], "Test")

        # Deprecated pools should never appear in output
        assert "pool-not-allocated" not in result
        assert "pool-manual" not in result
        assert "Distribution Pool" not in result
        assert "Reserve Pool" not in result
