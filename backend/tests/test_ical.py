"""Tests for iCal generation.

These tests verify that the iCal generator correctly:
- Escapes special characters per RFC 5545
- Folds long lines per RFC 5545 (75 octets)
- Formats DTSTAMP correctly
- Generates valid iCal format
- Only includes section assignments (no pool rows)
- Filters out vacation days
"""

from datetime import datetime, timezone

import pytest

from backend.ical import (
    _escape_text,
    _fold_ical_line,
    _format_dtstamp,
    generate_ics,
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


class TestFormatDtstamp:
    """Tests for _format_dtstamp() function."""

    def test_formats_utc_datetime(self) -> None:
        """Should format datetime as YYYYMMDDTHHMMSSz."""
        dt = datetime(2026, 1, 5, 14, 30, 0, tzinfo=timezone.utc)
        result = _format_dtstamp(dt)
        assert result == "20260105T143000Z"

    def test_converts_to_utc(self) -> None:
        """Non-UTC datetimes should be converted to UTC."""
        from datetime import timedelta

        # Create a datetime in UTC+1
        tz_plus_one = timezone(timedelta(hours=1))
        dt = datetime(2026, 1, 5, 15, 30, 0, tzinfo=tz_plus_one)
        result = _format_dtstamp(dt)
        # Should be converted to UTC (14:30)
        assert result == "20260105T143000Z"

    def test_strips_microseconds(self) -> None:
        """Microseconds should be stripped."""
        dt = datetime(2026, 1, 5, 14, 30, 0, 123456, tzinfo=timezone.utc)
        result = _format_dtstamp(dt)
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


    def _single_event_ics(self, slot_extra=None, clinician_id="clin-1"):
        state = self._make_test_state(assignments=[
            {"id": "a1", "rowId": "slot-a", "dateISO": "2026-01-05", "clinicianId": clinician_id},
        ])
        state["weeklyTemplate"]["locations"][0]["slots"][0].update(slot_extra or {})
        return generate_ics(state, ["2026-01-05"], "Test Calendar")

    @pytest.mark.parametrize("slot_extra,expected_end", [
        ({}, "20260106"),
        ({"endDayOffset": 1}, "20260107"),
        ({"endDayOffset": 9}, "20260109"),  # capped at +3 extra days
    ])
    def test_dtend_extends_for_shifts_crossing_midnight(self, slot_extra, expected_end) -> None:
        result = self._single_event_ics(slot_extra)
        assert "DTSTART;VALUE=DATE:20260105\r\n" in result
        assert f"DTEND;VALUE=DATE:{expected_end}\r\n" in result

    def test_skips_assignments_of_deleted_clinicians(self) -> None:
        result = self._single_event_ics(clinician_id="ghost")
        assert "BEGIN:VEVENT" not in result
        assert "ghost" not in result


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
