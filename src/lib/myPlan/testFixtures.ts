// Test-only demo data (SPEC §D): Dr. Lena Hoffmann's October 2026 at
// "Klinikum Mitte" and "MVZ Nord", built through the real template →
// buildScheduleRows path so slot ids, day types and locations are realistic.
import type {
  Assignment,
  Clinician,
  DayType,
  Holiday,
  Location,
  TemplateSlot,
  WeeklyCalendarTemplate,
  WorkplaceRow,
} from "../../api/client";
import { getDayType } from "../dayTypes";
import { REST_DAY_POOL_ID } from "../schedule";
import { buildScheduleRows } from "../shiftRows";
import type { PlanSource } from "./types";

const WEEKDAYS: DayType[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND: DayType[] = ["sat", "sun", "holiday"];
const ALL_DAYS: DayType[] = [...WEEKDAYS, ...WEEKEND];

export const LOCATIONS: Location[] = [
  { id: "mitte", name: "Klinikum Mitte", color: "#E9EEF5" },
  { id: "nord", name: "MVZ Nord", color: "#EEDFC4" },
];

const SECTIONS: Array<{ id: string; name: string; color: string }> = [
  { id: "kon", name: "Frühbesprechung", color: "#E7E5E4" },
  { id: "demo", name: "Demos/TuKos usw.", color: "#E7E5E4" },
  { id: "konv", name: "Konventionell", color: "#FFF4C1" },
  { id: "mrt", name: "MRT 08:00–16:30", color: "#BCD2FF" },
  { id: "mrts", name: "MRT spät", color: "#DEE8FF" },
  { id: "ct", name: "CT", color: "#E8E1F5" },
  { id: "ctint", name: "CT-Intervention", color: "#F1CE89" },
  { id: "sono", name: "Sonographie", color: "#BCE09F" },
  { id: "angio", name: "Angiographie", color: "#FFD9C9" },
  { id: "oatag", name: "OA-Tagdienst", color: "#DDF6EE" },
  { id: "nacht", name: "Nachtdienst", color: "#E0E7FF" },
  { id: "ruf", name: "Hintergrund OA", color: "#F1F5F9" },
  { id: "lke", name: "LKE/DL", color: "#CCFBF1" },
  { id: "zus", name: "Zusatzdienst", color: "#FFEDD5" },
];

type SlotSpec = {
  key: string;
  section: string;
  location: string;
  start: string;
  end: string;
  offset?: number;
  days: DayType[];
};

const SLOTS: SlotSpec[] = [
  { key: "kon", section: "kon", location: "mitte", start: "07:30", end: "08:00", days: WEEKDAYS },
  { key: "demo", section: "demo", location: "mitte", start: "07:15", end: "07:45", days: WEEKDAYS },
  { key: "konv", section: "konv", location: "mitte", start: "08:00", end: "16:30", days: WEEKDAYS },
  { key: "mrt", section: "mrt", location: "mitte", start: "08:00", end: "16:30", days: WEEKDAYS },
  { key: "mrts", section: "mrts", location: "mitte", start: "11:00", end: "20:00", days: WEEKDAYS },
  { key: "ct", section: "ct", location: "mitte", start: "08:00", end: "16:30", days: WEEKDAYS },
  { key: "ctint", section: "ctint", location: "mitte", start: "08:00", end: "17:30", days: WEEKDAYS },
  { key: "angio", section: "angio", location: "mitte", start: "08:00", end: "16:30", days: WEEKDAYS },
  { key: "oatag", section: "oatag", location: "mitte", start: "08:00", end: "16:30", days: WEEKDAYS },
  { key: "nacht", section: "nacht", location: "mitte", start: "17:00", end: "08:00", offset: 1, days: ALL_DAYS },
  { key: "ruf", section: "ruf", location: "mitte", start: "17:00", end: "08:00", offset: 1, days: WEEKDAYS },
  { key: "rufwe", section: "ruf", location: "mitte", start: "08:00", end: "08:00", offset: 1, days: WEEKEND },
  { key: "lke", section: "lke", location: "mitte", start: "08:00", end: "20:00", days: WEEKEND },
  { key: "zus", section: "zus", location: "mitte", start: "17:00", end: "22:00", days: WEEKDAYS },
  { key: "ctam", section: "ct", location: "nord", start: "08:00", end: "12:00", days: WEEKDAYS },
  { key: "ctpm", section: "ct", location: "nord", start: "12:00", end: "16:30", days: WEEKDAYS },
  { key: "sonoam", section: "sono", location: "nord", start: "08:00", end: "12:00", days: WEEKDAYS },
  { key: "sonopm", section: "sono", location: "nord", start: "12:00", end: "16:30", days: WEEKDAYS },
];

export const HOLIDAYS: Holiday[] = [
  { dateISO: "2026-10-03", name: "Tag der Deutschen Einheit" },
  { dateISO: "2026-11-01", name: "Allerheiligen" },
];

export const ROWS: WorkplaceRow[] = [
  ...SECTIONS.map((section) => ({
    id: section.id,
    name: section.name,
    kind: "class" as const,
    dotColorClass: "bg-slate-400",
    blockColor: section.color,
  })),
  { id: REST_DAY_POOL_ID, name: "ND-Frei", kind: "pool", dotColorClass: "bg-slate-200" },
  { id: "pool-vacation", name: "Urlaub/FzA", kind: "pool", dotColorClass: "bg-emerald-500" },
];

function buildTemplate(): WeeklyCalendarTemplate {
  return {
    version: 4,
    blocks: SECTIONS.map((section) => ({
      id: `blk-${section.id}`,
      sectionId: section.id,
      requiredSlots: 1,
    })),
    locations: LOCATIONS.map((location) => {
      const specs = SLOTS.filter((spec) => spec.location === location.id);
      const slots: TemplateSlot[] = specs.flatMap((spec) =>
        spec.days.map((dayType) => ({
          id: `${spec.key}-${dayType}`,
          locationId: location.id,
          rowBandId: `${location.id}-${spec.key}`,
          colBandId: `${location.id}-${dayType}`,
          blockId: `blk-${spec.section}`,
          requiredSlots: 1,
          startTime: spec.start,
          endTime: spec.end,
          endDayOffset: spec.offset ?? 0,
        })),
      );
      return {
        locationId: location.id,
        rowBands: specs.map((spec, order) => ({ id: `${location.id}-${spec.key}`, order })),
        colBands: ALL_DAYS.map((dayType, order) => ({
          id: `${location.id}-${dayType}`,
          order,
          dayType,
        })),
        slots,
      };
    }),
  };
}

const person = (id: string, name: string, extra: Partial<Clinician> = {}): Clinician => ({
  id,
  name,
  qualifiedClassIds: [],
  preferredClassIds: [],
  vacations: [],
  ...extra,
});

export const CLINICIANS: Clinician[] = [
  person("lh", "Dr. Lena Hoffmann", {
    workingHoursPerWeek: 40,
    vacations: [{ id: "v-lh", startISO: "2026-10-19", endISO: "2026-10-23" }],
  }),
  person("jw", "Jonas Weber"),
  person("sk", "Sophie Klein"),
  person("ms", "Mia Schulz"),
  person("fw", "Felix Wagner"),
  person("ls", "Lea Schneider", {
    vacations: [{ id: "v-ls", startISO: "2026-10-12", endISO: "2026-10-16" }],
  }),
  person("nw", "Nina Werner"),
  person("pr", "Paul Richter"),
  person("tk", "Tim Krüger"),
  person("ab", "Anna Becker"),
  person("mb", "Max Braun"),
  person("jb", "Jan Busch"),
];

/** Assignment of a clinician on a slot key; the slot id follows the date's day type. */
export function assign(clinicianId: string, slotKey: string, dateISO: string): Assignment {
  const rowId = slotKey.startsWith("pool-")
    ? slotKey
    : `${slotKey}-${getDayType(dateISO, HOLIDAYS)}`;
  return { id: `${clinicianId}:${slotKey}:${dateISO}`, rowId, dateISO, clinicianId };
}

const LENA: Array<[string, string]> = [
  // Week 40/41 (context)
  ["2026-10-03", "lke"],
  ["2026-10-08", "nacht"],
  ["2026-10-09", REST_DAY_POOL_ID],
  // Week 42 (SPEC D3)
  ["2026-10-12", "kon"],
  ["2026-10-12", "mrt"],
  ["2026-10-13", "ctam"],
  ["2026-10-13", "sonopm"],
  ["2026-10-14", "nacht"],
  ["2026-10-15", REST_DAY_POOL_ID],
  ["2026-10-16", "angio"],
  ["2026-10-18", "lke"],
  // Week 43: vacation Mon–Fri. Week 44: draft.
  ["2026-10-26", "mrt"],
  ["2026-10-30", "konv"],
  ["2026-10-30", "zus"],
];

const COLLEAGUES: Array<[string, string, string]> = [
  ["sk", "mrt", "2026-10-12"],
  ["jw", "oatag", "2026-10-12"],
  ["tk", "konv", "2026-10-12"],
  ["pr", "mrts", "2026-10-12"],
  ["mb", "nacht", "2026-10-12"],
  ["ab", "ruf", "2026-10-12"],
  ["fw", "ctam", "2026-10-12"],
  ["ls", "mrt", "2026-10-12"], // on vacation → hidden
  ["fw", "sonoam", "2026-10-13"],
  ["fw", "ctpm", "2026-10-13"],
  ["jw", "ruf", "2026-10-14"],
  ["sk", "mrts", "2026-10-14"],
  ["nw", "ctint", "2026-10-14"],
  ["fw", "zus", "2026-10-14"],
  ["mb", "kon", "2026-10-14"],
  ["mb", "mrt", "2026-10-14"],
  ["tk", "konv", "2026-10-14"],
  ["ms", "angio", "2026-10-14"],
  ["ab", "oatag", "2026-10-14"],
  ["mb", "kon", "2026-10-15"],
  ["ms", "angio", "2026-10-16"],
  ["jw", "oatag", "2026-10-16"],
  ["jb", "nacht", "2026-10-16"],
  ["sk", "lke", "2026-10-18"],
  ["jw", "rufwe", "2026-10-18"],
  ["fw", "nacht", "2026-10-18"],
];

export const ASSIGNMENTS: Assignment[] = [
  ...LENA.map(([dateISO, slotKey]) => assign("lh", slotKey, dateISO)),
  ...COLLEAGUES.map(([clinicianId, slotKey, dateISO]) => assign(clinicianId, slotKey, dateISO)),
];

export const PUBLISHED_WEEKS = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];

export function makeSource(
  overrides: Partial<PlanSource> = {},
  { locationsEnabled = true } = {},
): PlanSource {
  const locations = overrides.locations ?? LOCATIONS;
  return {
    scheduleRows: buildScheduleRows(ROWS, locations, locationsEnabled, buildTemplate()),
    assignments: ASSIGNMENTS,
    clinicians: CLINICIANS,
    locations,
    holidays: HOLIDAYS,
    publishedWeekStartISOs: PUBLISHED_WEEKS,
    solverSettings: {
      enforceSameLocationPerDay: true,
      onCallRestEnabled: false,
      onCallRestClassId: "kon",
      onCallRestDaysBefore: 0,
      onCallRestDaysAfter: 1,
      preferContinuousShifts: true,
    },
    ...overrides,
  };
}
