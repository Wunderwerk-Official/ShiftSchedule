import { describe, expect, it, vi } from "vitest";
import type { AppState, Assignment } from "../api/client";
import {
  describeShiftsImportQuestion,
  describeShiftsImportResult,
  IMPORT_BACKUP_FAILED_MESSAGE,
  isISODate,
  MAX_SHIFTS_FILE_ENTRIES,
  NO_SHIFTS_FOR_CALENDAR_MESSAGE,
  NO_SHIFTS_FOUND_MESSAGE,
  prepareShiftsImport,
  readShiftsFile,
  saveShiftsFileImport,
  shiftsFileName,
  TOO_MANY_ENTRIES_MESSAGE,
  type ShiftsImportCalendar,
  type ShiftsImportSummary,
} from "./shiftsFileImport";

const current = { assignments: [{ id: "old" }] } as unknown as AppState;
const next = { assignments: [{ id: "new" }] } as unknown as AppState;

const shift = (id: string, extra: Partial<Assignment> = {}): Assignment => ({
  id,
  rowId: "slot-mon",
  dateISO: "2026-11-02",
  clinicianId: "anna",
  ...extra,
});

describe("shiftsFileName", () => {
  it("uses the local date and the word shifts", () => {
    // 00:30 on 3 Nov in local time is still 2 Nov in UTC east of Greenwich.
    expect(shiftsFileName(new Date(2026, 10, 3, 0, 30))).toBe("shifts-2026-11-03.json");
  });
});

describe("isISODate", () => {
  it.each(["2026-11-02", "2028-02-29"])("accepts %s", (value) => {
    expect(isISODate(value)).toBe(true);
  });

  it.each(["2026-02-30", "2026-13-01", "not-a-date", "2026-1-5", "", 20261102, null])(
    "rejects %s",
    (value) => {
      expect(isISODate(value)).toBe(false);
    },
  );
});

describe("readShiftsFile", () => {
  it.each([
    ["a JSON array", [shift("a")]],
    ["an object without shifts", { name: "foo", items: [1, 2] }],
    ["a number", 3],
    ["null", null],
  ])("refuses %s", (_label, payload) => {
    expect(() => readShiftsFile(payload)).toThrow(NO_SHIFTS_FOUND_MESSAGE);
  });

  it("reads a full calendar export as well", () => {
    expect(readShiftsFile({ state: { assignments: [shift("a")] } }).assignments).toEqual([shift("a")]);
  });

  it("skips and counts entries that are not valid shifts", () => {
    const result = readShiftsFile({
      assignments: [
        shift("ok", { locked: true, source: "solver" }),
        { foo: 1 },
        "text",
        shift("no-person", { clinicianId: "" }),
        shift("no-slot", { rowId: 7 as unknown as string }),
        shift("bad-date", { dateISO: "2026-02-30" }),
        shift("bad-locked", { locked: "yes" as unknown as boolean }),
        shift("bad-source", { source: "robot" as unknown as "manual" }),
        { ...shift("x", { dateISO: "2026-11-03" }), id: 5 },
      ],
    });
    expect(result.assignments).toEqual([shift("ok", { locked: true, source: "solver" })]);
    expect(result.invalid).toBe(8);
    expect(result.duplicates).toBe(0);
  });

  it("keeps only the known fields of a shift", () => {
    const result = readShiftsFile({ assignments: [{ ...shift("a"), source: null, note: "x" }] });
    expect(result.assignments).toEqual([shift("a")]);
  });

  it("keeps each person, slot and date once and counts the repeats", () => {
    const result = readShiftsFile({
      assignments: [
        shift("a"),
        shift("a-copy"),
        shift("a-copy-2", { locked: true }),
        shift("b", { rowId: "slot-other" }),
      ],
    });
    expect(result.assignments.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.duplicates).toBe(2);
  });

  it("gives missing and repeated ids new ones", () => {
    const { id: _ignored, ...withoutId } = shift("x", { dateISO: "2026-11-04" });
    const result = readShiftsFile({
      assignments: [
        shift("as-import-1"),
        shift("same", { dateISO: "2026-11-03" }),
        shift("same", { dateISO: "2026-11-05" }),
        withoutId,
      ],
    });
    const ids = result.assignments.map((item) => item.id);
    expect(ids).toEqual(["as-import-1", "same", "as-import-2", "as-import-3"]);
  });

  it("refuses more than the entry limit before checking entries", () => {
    const assignments = Array.from({ length: MAX_SHIFTS_FILE_ENTRIES + 1 }, () => ({}));
    expect(() => readShiftsFile({ assignments })).toThrow(TOO_MANY_ENTRIES_MESSAGE);
    expect(readShiftsFile({ assignments: assignments.slice(1) }).invalid).toBe(MAX_SHIFTS_FILE_ENTRIES);
  });
});

describe("prepareShiftsImport", () => {
  // A stand-in for the page's normalizer: it drops shifts in unknown slots and
  // in the Monday slot on the holiday 2026-11-03 or on a Tuesday.
  const calendar = (holidays: string[] = []): ShiftsImportCalendar => ({
    clinicianIds: new Set(["anna", "ben"]),
    slotIds: new Set(["slot-mon"]),
    holidayDates: new Set(holidays),
    buildState: (assignments) =>
      ({
        assignments: assignments.filter(
          (item) => item.rowId === "slot-mon" && item.dateISO === "2026-11-02",
        ),
      }) as AppState,
  });

  it.each([
    ["an empty file", { version: 1, assignments: [] }],
    ["a file of entries that are not shifts", { assignments: [{ foo: 1 }, { bar: 2 }] }],
    ["another team's file", { assignments: [shift("x", { clinicianId: "someone-else" })] }],
    ["a file whose shifts all fall away", { assignments: [shift("x", { rowId: "slot-gone" })] }],
  ])("refuses %s without changing anything", (_label, payload) => {
    const buildState = vi.fn(calendar().buildState);
    expect(() => prepareShiftsImport(payload, { ...calendar(), buildState })).toThrow(
      NO_SHIFTS_FOR_CALENDAR_MESSAGE,
    );
  });

  it("refuses when the calendar cannot be saved", () => {
    expect(() =>
      prepareShiftsImport({ assignments: [shift("a")] }, { ...calendar(), buildState: () => null }),
    ).toThrow("The current calendar cannot be saved. Fix its template first.");
  });

  it("counts what is imported and why the rest is skipped", () => {
    const { next, summary } = prepareShiftsImport(
      {
        assignments: [
          shift("kept"),
          shift("kept-again"),
          { foo: 1 },
          shift("other-person", { clinicianId: "zoe" }),
          shift("gone", { rowId: "slot-gone" }),
          shift("holiday", { dateISO: "2026-11-03" }),
          shift("tuesday", { dateISO: "2026-11-10" }),
        ],
      },
      calendar(["2026-11-03"]),
    );
    expect(next.assignments.map((item) => item.id)).toEqual(["kept"]);
    expect(summary).toEqual({
      imported: 1,
      invalid: 1,
      duplicates: 1,
      droppedClinicians: 1,
      droppedSlots: 1,
      droppedHolidays: 1,
      droppedDayPlan: 1,
    });
  });
});

describe("import texts", () => {
  const summary: ShiftsImportSummary = {
    imported: 434,
    invalid: 0,
    duplicates: 0,
    droppedClinicians: 0,
    droppedSlots: 0,
    droppedHolidays: 12,
    droppedDayPlan: 0,
  };

  it("asks with both counts and the file name, and says the backup replaces the previous one", () => {
    const question = describeShiftsImportQuestion(
      { currentCount: 446, summary, apply: vi.fn() },
      "shifts-2026-11-02.json",
    );
    expect(question).toBe(
      "Replace all 446 current shifts with 434 shifts from “shifts-2026-11-02.json”? " +
        "Every week is replaced, locked shifts too. " +
        "Skipped from the file: 12 on days that are now holidays. " +
        "The current calendar is saved in Calendar snapshots first; this automatic backup replaces the previous one.",
    );
  });

  it("reports holidays apart from slots that no longer exist", () => {
    expect(describeShiftsImportResult({ ...summary, droppedSlots: 2, backupName: "Backup" })).toBe(
      "Imported 434 shifts. Skipped 2 in slots that no longer exist, 12 on days that are now holidays. " +
        "A backup of the previous calendar is in Calendar snapshots: “Backup”.",
    );
  });

  it("lists every reason with singular and plural", () => {
    expect(
      describeShiftsImportResult({
        imported: 1,
        invalid: 1,
        duplicates: 2,
        droppedClinicians: 1,
        droppedSlots: 0,
        droppedHolidays: 0,
        droppedDayPlan: 3,
        backupName: "Backup",
      }),
    ).toBe(
      "Imported 1 shift. Skipped 1 entry that is not a valid shift, 2 duplicates, " +
        "1 shift of a person not in this calendar, 3 that no longer fit the day's plan. " +
        "A backup of the previous calendar is in Calendar snapshots: “Backup”.",
    );
  });
});

describe("saveShiftsFileImport", () => {
  const currentRevision = async () => "rev-7";

  it("backs up the shown calendar at this tab's revision before saving the imported one", async () => {
    const calls: string[] = [];
    const createBackup = vi.fn(async (state: AppState, expectedRevision?: string | null) => {
      calls.push("backup");
      expect(state).toBe(current);
      expect(expectedRevision).toBe("rev-7");
      return { name: "Auto-backup before shifts file import" };
    });
    const saveState = vi.fn(async (state: AppState) => {
      calls.push("save");
      expect(state).toBe(next);
    });

    const result = await saveShiftsFileImport(current, next, { currentRevision, createBackup, saveState });

    expect(calls).toEqual(["backup", "save"]);
    expect(result.backupName).toBe("Auto-backup before shifts file import");
  });

  it("imports nothing when the backup fails", async () => {
    const createBackup = vi.fn(async () => {
      throw new Error("Session expired");
    });
    const saveState = vi.fn(async () => undefined);

    await expect(
      saveShiftsFileImport(current, next, { currentRevision, createBackup, saveState }),
    ).rejects.toThrow(`${IMPORT_BACKUP_FAILED_MESSAGE} (Session expired)`);
    expect(saveState).not.toHaveBeenCalled();
  });

  it("imports nothing and keeps the backup when the calendar changed in another tab", async () => {
    const createBackup = vi.fn(async () => {
      throw new Error("The calendar changed in another tab or operation.");
    });
    const saveState = vi.fn(async () => undefined);

    await expect(
      saveShiftsFileImport(current, next, { currentRevision, createBackup, saveState }),
    ).rejects.toThrow("The calendar changed in another tab or operation.");
    expect(saveState).not.toHaveBeenCalled();
  });

  it("writes no backup when a queued save of this tab failed", async () => {
    const createBackup = vi.fn(async () => ({ name: "Backup" }));
    const saveState = vi.fn(async () => undefined);
    const failedRevision = async () => {
      throw new Error("Failed to save state: 500");
    };

    await expect(
      saveShiftsFileImport(current, next, { currentRevision: failedRevision, createBackup, saveState }),
    ).rejects.toThrow(`${IMPORT_BACKUP_FAILED_MESSAGE} (Failed to save state: 500)`);
    expect(createBackup).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it("passes on a failing save after the backup", async () => {
    const createBackup = vi.fn(async () => ({ name: "Auto-backup before shifts file import" }));
    const saveState = vi.fn(async () => {
      throw new Error("Failed to save state: 500");
    });

    await expect(
      saveShiftsFileImport(current, next, { currentRevision, createBackup, saveState }),
    ).rejects.toThrow("Failed to save state: 500");
    expect(createBackup).toHaveBeenCalledTimes(1);
  });
});
