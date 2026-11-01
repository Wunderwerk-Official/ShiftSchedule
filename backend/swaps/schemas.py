"""Request bodies of the swap endpoints. A body that breaks these rules is a 422."""

from datetime import date
from typing import Annotated, List, Literal, Optional

from pydantic import AfterValidator, BaseModel, Field, model_validator

from .policy import APPROVER_MAX_CHARS, MAX_PICKED_DATES, NOTE_MAX_CHARS

DATE = r"^\d{4}-\d{2}-\d{2}$"


def _real_date(value: str) -> str:
    date.fromisoformat(value)  # 2026-02-30 matches DATE but is no date
    return value


DateISO = Annotated[str, Field(pattern=DATE), AfterValidator(_real_date)]
SwapMode = Literal["swap", "handover", "cover"]


class AssignmentRefIn(BaseModel):
    assignmentId: Optional[str] = None
    rowId: str
    dateISO: DateISO
    clinicianId: str


class SlotRefIn(BaseModel):
    rowId: str
    dateISO: DateISO
    fp: Optional[str] = None  # apply only: the slot fingerprint the preview showed


class ItemRefIn(BaseModel):
    rowId: str
    dateISO: DateISO
    clinicianId: str
    fp: str


class RestDayMoveIn(BaseModel):
    fromClinicianId: str
    toClinicianId: str
    dateISO: DateISO


class HiddenRemovalIn(BaseModel):
    clinicianId: str


class CandidatesRequest(BaseModel):
    mode: SwapMode
    assignment: Optional[AssignmentRefIn] = None
    slot: Optional[SlotRefIn] = None
    wholeDay: bool = False
    partnerId: Optional[str] = None
    range: Literal["sameWeek", "fourWeeks", "dates"] = "fourWeeks"
    dates: List[DateISO] = Field(default_factory=list, max_length=MAX_PICKED_DATES)
    sameTypeOnly: bool = False
    expectedRevision: Optional[str] = None

    @model_validator(mode="after")
    def _target_matches_mode(self) -> "CandidatesRequest":
        if self.mode == "cover":
            if self.slot is None or self.assignment is not None:
                raise ValueError("cover needs a slot and no assignment")
        elif self.assignment is None or self.slot is not None:
            raise ValueError(f"{self.mode} needs an assignment and no slot")
        if self.mode == "swap" and self.range == "dates" and not self.dates:
            raise ValueError("range 'dates' needs at least one date")
        return self


class ApplyRequest(BaseModel):
    mode: SwapMode
    give: List[ItemRefIn] = Field(default_factory=list, max_length=50)
    wholeDay: bool = False
    slot: Optional[SlotRefIn] = None
    partnerId: str
    take: Optional[List[ItemRefIn]] = Field(default=None, max_length=50)
    restDayMoves: List[RestDayMoveIn] = Field(default_factory=list, max_length=10)
    removeHidden: Optional[HiddenRemovalIn] = None
    expectedRevision: str
    consent: bool = False
    note: Optional[str] = Field(default=None, max_length=NOTE_MAX_CHARS)
    approverName: Optional[str] = Field(default=None, max_length=APPROVER_MAX_CHARS)
    overrideNotice: bool = False
    acknowledgedWarnings: List[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _items_match_mode(self) -> "ApplyRequest":
        if self.mode == "cover":
            if self.slot is None or not self.slot.fp or self.give or self.take:
                raise ValueError("cover needs a slot with its fingerprint and no give or take items")
            return self
        if not self.give or self.slot is not None or self.removeHidden is not None:
            raise ValueError(f"{self.mode} needs give items and no slot or hidden removal")
        if self.mode == "swap" and not self.take:
            raise ValueError("swap needs take items")
        if self.mode == "handover" and self.take:
            raise ValueError("handover takes nothing back")
        return self


class UndoRequest(BaseModel):
    expectedRevision: str
