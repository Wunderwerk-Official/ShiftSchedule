import type {
  Assignment,
  Clinician,
  Location,
  WeeklyCalendarTemplate,
  WorkplaceRow,
} from "../api/client";

// The API types live in api/client; re-exported here for existing importers.
export type {
  Assignment,
  AssignmentSource,
  Clinician,
  Location,
  SubShift,
  WorkplaceRow,
} from "../api/client";

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
  weightTimeWindow: 20,
  weightSectionPreference: 10,
  weightWorkingHours: 3,
};

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
