// Seed the clinic-sheet (Excel "Arbeitsplan") row structure into ONE user's
// schedule — by default the admin account. Writes only that user's state row;
// every other user keeps their own untouched state.
//
// What it replaces: locations, sections, weekly template (rows/sub-columns/
// slots), pool names, and it CLEARS all assignments of the target user.
// What it keeps: clinicians (incl. vacations), holidays, solver settings
// (plus it switches the calendar layout to the monthly clinic sheet and
// disables enforceSameLocationPerDay, since the blocks here are visual
// sections of one clinic, not separate sites).
//
// Usage (dry run first, then apply):
//   API_BASE=http://localhost:8000 ADMIN_USERNAME=admin ADMIN_PASSWORD=... \
//     node scripts/seed-clinic-sheet-admin.mjs
//   ... same command with --apply to actually write.

const API_BASE = process.env.API_BASE ?? "http://localhost:8000";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "dev-admin-password";
const APPLY = process.argv.includes("--apply");

const EXCEL_PINK = "#FF99CC";
const EXCEL_GREEN = "#339966";
const WHITE = "#FFFFFF";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "holiday"];
const WEEKEND = ["sat", "sun", "holiday"];

// The Excel row structure: blocks (rendered as sections separated by spacer
// rows) → rows → per-day sub-columns. `assistant`/`senior` define the 4+2
// split: `senior: null` means the row has no Oberarzt area and spans all six
// name columns. `required` counts mirror the typical staffing in the sheet.
const STRUCTURE = [
  {
    location: "Konventionell",
    color: EXCEL_PINK,
    rows: [
      { name: "Konventionell", days: WEEKDAYS, assistant: 2, senior: 2 },
      { name: "FHA konventionell", days: WEEKDAYS, assistant: 0, senior: null },
      { name: "FHA MRT", days: WEEKDAYS, assistant: 1, senior: 0 },
      { name: "FHA CT", days: WEEKDAYS, assistant: 1, senior: null },
      { name: "Kinder / Sono", days: WEEKDAYS, assistant: 2, senior: 2 },
    ],
  },
  {
    location: "MRT",
    color: EXCEL_PINK,
    rows: [
      { name: "MRT 08:00–17:00", days: WEEKDAYS, assistant: 2, senior: 2, start: "08:00", end: "17:00" },
      { name: "MRT 11:00–20:00", days: WEEKDAYS, assistant: 1, senior: 0, start: "11:00", end: "20:00" },
      { name: "Mammadiagnostik", days: WEEKDAYS, assistant: 2, senior: 1 },
    ],
  },
  {
    location: "CT",
    color: EXCEL_PINK,
    rows: [
      { name: "CT 08:00–17:00", days: WEEKDAYS, assistant: 2, senior: 2, start: "08:00", end: "17:00" },
      { name: "CT 10:00–19:00", days: WEEKDAYS, assistant: 1, senior: null, start: "10:00", end: "19:00" },
      { name: "CT Pool", days: WEEKDAYS, assistant: 1, senior: null },
    ],
  },
  {
    location: "Kardiologie",
    color: EXCEL_PINK,
    rows: [
      { name: "kardiologischer Arbeitsplatz", days: WEEKDAYS, assistant: 1, senior: 0 },
    ],
  },
  {
    location: "Intervention",
    color: EXCEL_PINK,
    rows: [
      { name: "Angio", days: WEEKDAYS, assistant: 1, senior: 1 },
      { name: "CT-Intervention", days: WEEKDAYS, assistant: 1, senior: 1 },
    ],
  },
  {
    location: "Ambulanz/Station",
    color: EXCEL_PINK,
    rows: [
      { name: "Ambulanz", days: WEEKDAYS, assistant: 1, senior: 1 },
      { name: "SDI Station", days: WEEKDAYS, assistant: 1, senior: 1 },
    ],
  },
  {
    location: "Wissenschaft/NeuroRad",
    color: EXCEL_PINK,
    rows: [
      { name: "Wissenschaft", days: WEEKDAYS, assistant: 2, senior: null },
      { name: "NeuroRad", days: WEEKDAYS, assistant: 2, senior: null },
    ],
  },
  {
    location: "Dienste",
    color: EXCEL_PINK,
    rows: [
      {
        name: "LKE/DL",
        days: ALL_DAYS,
        assistant: 1,
        senior: 2,
        seniorDays: WEEKDAYS,
      },
      { name: "Zusatzdienst", days: ["fri", ...WEEKEND], assistant: 1, senior: null },
      {
        name: "Nachtdienst",
        days: ALL_DAYS,
        assistant: 1,
        senior: 2,
        seniorRequiredByDay: { sat: 1, sun: 1, holiday: 1 },
        start: "17:00",
        end: "08:00",
        endDayOffset: 1,
      },
    ],
  },
  {
    location: "Konferenzen",
    color: EXCEL_GREEN,
    rows: [
      { name: "Demos/TuKos usw.", days: WEEKDAYS, assistant: 0, senior: null, start: "07:15", end: "07:45" },
    ],
  },
  {
    location: "Abwesenheiten",
    color: WHITE,
    rows: [
      { name: "Reisefrei", days: ALL_DAYS, assistant: 0, senior: null },
      { name: "Elternzeit usw.", days: ALL_DAYS, assistant: 0, senior: null },
      { name: "HomeOffice", days: ALL_DAYS, assistant: 0, senior: null },
      { name: "Krank", days: ALL_DAYS, assistant: 0, senior: null },
    ],
  },
];

const SENIOR_SECTION_NAME = "Oberärzte";
const DEFAULT_START = "08:00";
const DEFAULT_END = "17:00";

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildStructure = () => {
  const locations = [];
  const rows = [];
  const blocks = [];
  const templateLocations = [];
  const blockIdBySection = new Map();

  const addSection = (name, color, locationId) => {
    const id = `sec-${slug(name)}`;
    if (blockIdBySection.has(id)) return { sectionId: id, blockId: blockIdBySection.get(id) };
    rows.push({
      id,
      name,
      kind: "class",
      dotColorClass: "bg-pink-200",
      blockColor: color,
      locationId,
    });
    const blockId = `block-${slug(name)}`;
    blocks.push({ id: blockId, sectionId: id, label: "", requiredSlots: 0, color });
    blockIdBySection.set(id, blockId);
    return { sectionId: id, blockId };
  };

  for (const group of STRUCTURE) {
    const locationId = `loc-${slug(group.location)}`;
    locations.push({ id: locationId, name: group.location });

    const rowBands = [];
    const colBands = [];
    const slots = [];
    const usedDayTypes = new Set();
    const needsSenior = new Set();
    for (const row of group.rows) {
      for (const day of row.days) {
        usedDayTypes.add(day);
        const seniorDays = row.senior === null ? [] : row.seniorDays ?? row.days;
        if (seniorDays.includes(day)) needsSenior.add(day);
      }
    }
    const colBandId = (day, order) => `col-${slug(group.location)}-${day}-${order}`;
    for (const day of ALL_DAYS) {
      if (!usedDayTypes.has(day)) continue;
      colBands.push({ id: colBandId(day, 1), label: "Assistenten", order: 1, dayType: day });
      if (needsSenior.has(day)) {
        colBands.push({ id: colBandId(day, 2), label: "OA", order: 2, dayType: day });
      }
    }

    group.rows.forEach((row, rowIndex) => {
      const bandId = `band-${slug(group.location)}-${slug(row.name)}`;
      rowBands.push({ id: bandId, label: row.name, order: rowIndex + 1 });
      const { blockId } = addSection(row.name, group.color, locationId);
      const senior =
        row.senior === null
          ? null
          : addSection(SENIOR_SECTION_NAME, EXCEL_PINK, locationId);
      const start = row.start ?? DEFAULT_START;
      const end = row.end ?? DEFAULT_END;
      for (const day of row.days) {
        slots.push({
          id: `slot-${bandId}-${day}-1`,
          locationId,
          rowBandId: bandId,
          colBandId: colBandId(day, 1),
          blockId,
          requiredSlots: row.assistant,
          startTime: start,
          endTime: end,
          endDayOffset: row.endDayOffset ?? 0,
        });
        const seniorDays = row.senior === null ? [] : row.seniorDays ?? row.days;
        if (senior && seniorDays.includes(day)) {
          slots.push({
            id: `slot-${bandId}-${day}-2`,
            locationId,
            rowBandId: bandId,
            colBandId: colBandId(day, 2),
            blockId: senior.blockId,
            requiredSlots: row.seniorRequiredByDay?.[day] ?? row.senior,
            startTime: start,
            endTime: end,
            endDayOffset: row.endDayOffset ?? 0,
          });
        }
      }
    });

    templateLocations.push({ locationId, rowBands, colBands, slots });
  }

  return { locations, rows, blocks, templateLocations };
};

const assertOk = async (res, label) => {
  if (res.ok) return;
  const body = await res.text();
  const detail = body ? ` (${body})` : "";
  throw new Error(`${label} failed: ${res.status}${detail}`);
};

const run = async () => {
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  await assertOk(loginRes, "Login");
  const { access_token: token, user } = await loginRes.json();
  if (!token) throw new Error("Login failed: missing access token.");
  console.log(`Login ok for ${user?.username ?? ADMIN_USERNAME} (${API_BASE}).`);

  const stateRes = await fetch(`${API_BASE}/v1/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertOk(stateRes, "Get state");
  const current = await stateRes.json();

  const { locations, rows, blocks, templateLocations } = buildStructure();

  const poolRows = [
    { id: "pool-rest-day", name: "ND-Frei", kind: "pool", dotColorClass: "bg-slate-200" },
    { id: "pool-vacation", name: "Urlaub/FzA", kind: "pool", dotColorClass: "bg-emerald-500" },
  ];

  const nextState = {
    ...current,
    locations,
    locationsEnabled: true,
    rows: [...rows, ...poolRows],
    weeklyTemplate: { version: 4, blocks, locations: templateLocations },
    assignments: [],
    minSlotsByRowId: {},
    slotOverridesByKey: {},
    solverRules: [],
    solverSettings: {
      ...(current.solverSettings ?? {}),
      scheduleLayout: "clinicSheet",
      enforceSameLocationPerDay: false,
    },
  };

  const slotCount = templateLocations.reduce((sum, loc) => sum + loc.slots.length, 0);
  console.log(
    `Structure: ${locations.length} blocks, ${rows.length} sections, ` +
      `${templateLocations.reduce((s, l) => s + l.rowBands.length, 0)} rows, ${slotCount} slots.`,
  );
  console.log(
    `Keeps ${current.clinicians?.length ?? 0} clinicians and ${current.holidays?.length ?? 0} holidays; ` +
      `clears ${current.assignments?.length ?? 0} assignments of user "${user?.username ?? ADMIN_USERNAME}".`,
  );

  if (!APPLY) {
    console.log("\nDry run only — nothing written. Re-run with --apply to write.");
    return;
  }

  const saveRes = await fetch(`${API_BASE}/v1/state`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(nextState),
  });
  await assertOk(saveRes, "Save state");
  const saved = await saveRes.json();
  console.log(
    `Saved. Server state now has ${saved.rows?.length ?? 0} rows, ` +
      `${saved.assignments?.length ?? 0} assignments, layout=${saved.solverSettings?.scheduleLayout}.`,
  );
};

run().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
