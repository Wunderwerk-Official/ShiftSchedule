import type { PreferredWorkingTimes, WeeklyCalendarTemplate } from "../api/client";
import { addDays, startOfWeek, toISODate } from "../lib/date";

export type WorkplaceRow = {
  id: string;
  name: string;
  kind: "class" | "pool";
  dotColorClass: string;
  blockColor?: string;
  locationId?: string;
  subShifts?: SubShift[];
};

export type Location = {
  id: string;
  name: string;
};

export type SubShift = {
  id: string;
  name: string;
  order: 1 | 2 | 3;
  startTime: string;
  endTime: string;
  endDayOffset?: number;
  hours?: number;
};

export type AssignmentSource = "manual" | "solver";

export type Assignment = {
  id: string;
  rowId: string;
  dateISO: string; // YYYY-MM-DD
  clinicianId: string;
  source?: AssignmentSource; // "manual" (default) or "solver" - tracks how assignment was created
};

export type VacationPeriod = {
  id: string;
  startISO: string;
  endISO: string;
};

export type Clinician = {
  id: string;
  name: string;
  qualifiedClassIds: string[];
  preferredClassIds: string[];
  vacations: VacationPeriod[];
  preferredWorkingTimes?: PreferredWorkingTimes;
  workingHoursPerWeek?: number;
};

export const locations: Location[] = [{ id: "loc-default", name: "Berlin" }];
export const locationsEnabled = true;

export const workplaceRows: WorkplaceRow[] = [
  {
    id: "mri",
    name: "MRI",
    kind: "class",
    dotColorClass: "bg-violet-500",
    blockColor: "#E8E1F5",
    locationId: "loc-default",
    subShifts: [
      {
        id: "s1",
        name: "Shift 1",
        order: 1,
        startTime: "08:00",
        endTime: "16:00",
        endDayOffset: 0,
      },
    ],
  },
  {
    id: "pool-rest-day",
    name: "Rest Day",
    kind: "pool",
    dotColorClass: "bg-slate-200",
  },
  { id: "pool-vacation", name: "Vacation", kind: "pool", dotColorClass: "bg-emerald-500" },
];

export const defaultMinSlotsByRowId: Record<
  string,
  { weekday: number; weekend: number }
> = {
  "mri::s1": { weekday: 1, weekend: 1 },
};

export const defaultSolverSettings = {
  enforceSameLocationPerDay: true,
  onCallRestEnabled: false,
  onCallRestClassId: "mri",
  onCallRestDaysBefore: 1,
  onCallRestDaysAfter: 1,
  preferContinuousShifts: true,
  scheduleLayout: "classic" as import("../api/client").ScheduleLayout,
  // Optimization weights
  weightCoverage: 1000,
  weightSlack: 1000,
  weightTotalAssignments: 100,
  weightSlotPriority: 10,
  weightTimeWindow: 5,
  weightSectionPreference: 1,
  weightWorkingHours: 1,
};

export const defaultSolverRules: Array<{
  id: string;
  name: string;
  enabled: boolean;
  ifShiftRowId: string;
  dayDelta: -1 | 1;
  thenType: "shiftRow" | "off";
  thenShiftRowId?: string;
}> = [];

export const clinicians: Clinician[] = [
  {
    id: "alex-hartmann",
    name: "Alex Hartmann",
    qualifiedClassIds: ["mri"],
    preferredClassIds: ["mri"],
    vacations: [],
    preferredWorkingTimes: {
      mon: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      tue: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      wed: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      thu: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      fri: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      sat: { startTime: "07:00", endTime: "17:00", requirement: "none" },
      sun: { startTime: "07:00", endTime: "17:00", requirement: "none" },
    },
    workingHoursPerWeek: 38,
  },
];

export const weeklyTemplate: WeeklyCalendarTemplate = {
  version: 4,
  blocks: [
    {
      id: "block-mri-1",
      sectionId: "mri",
      requiredSlots: 0,
    },
  ],
  locations: [
    {
      locationId: "loc-default",
      rowBands: [{ id: "row-1", label: "Row 1", order: 1 }],
      colBands: [
        { id: "col-mon-1", label: "", order: 1, dayType: "mon" },
        { id: "col-tue-1", label: "", order: 1, dayType: "tue" },
        { id: "col-wed-1", label: "", order: 1, dayType: "wed" },
        { id: "col-thu-1", label: "", order: 1, dayType: "thu" },
        { id: "col-fri-1", label: "", order: 1, dayType: "fri" },
        { id: "col-sat-1", label: "", order: 1, dayType: "sat" },
        { id: "col-sun-1", label: "", order: 1, dayType: "sun" },
        { id: "col-holiday-1", label: "", order: 1, dayType: "holiday" },
      ],
      slots: [
        {
          id: "slot-mri-mon-1",
          locationId: "loc-default",
          rowBandId: "row-1",
          colBandId: "col-mon-1",
          blockId: "block-mri-1",
          requiredSlots: 1,
          startTime: "08:00",
          endTime: "16:00",
          endDayOffset: 0,
        },
      ],
    },
  ],
};

const seedWeekStart = startOfWeek(new Date("2025-12-21T12:00:00"), 1);

function isoAt(dayOffset: number) {
  return toISODate(addDays(seedWeekStart, dayOffset));
}

export const assignments: Assignment[] = [];

export function buildAssignmentMap(items: Assignment[]) {
  const map = new Map<string, Assignment[]>();
  for (const a of items) {
    const key = `${a.rowId}__${a.dateISO}`;
    const existing = map.get(key);
    if (existing) existing.push(a);
    else map.set(key, [a]);
  }
  return map;
}
