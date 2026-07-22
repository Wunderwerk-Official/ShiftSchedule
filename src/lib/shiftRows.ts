import type {
  AppState,
  Assignment,
  DayType,
  Location,
  MinSlots,
  ScheduleLayout,
  SubShift,
  TemplateBlock,
  TemplateColBand,
  TemplateRowBand,
  TemplateSlot,
  WeeklyCalendarTemplate,
  WeeklyTemplateLocation,
  WorkplaceRow,
} from "../api/client";
import { normalizePreferredWorkingTimes } from "./clinicianPreferences";
import { DAY_TYPES, getDayType } from "./dayTypes";

export const SHIFT_ROW_SEPARATOR = "::";
export const DEFAULT_LOCATION_ID = "loc-default";
export const DEFAULT_LOCATION_NAME = "Default";
const REST_DAY_POOL_ID = "pool-rest-day";
const DEPRECATED_POOL_IDS = new Set(["pool-not-allocated", "pool-manual"]);
const DEFAULT_SUB_SHIFT_MINUTES = 8 * 60;
const DEFAULT_SUB_SHIFT_START_MINUTES = 8 * 60;

/**
 * Calculate relative luminance of a hex color using WCAG formula.
 * Returns a value between 0 (black) and 1 (white).
 */
export function getLuminance(hex: string): number {
  const cleanHex = hex.replace("#", "");
  const r = parseInt(cleanHex.slice(0, 2), 16) / 255;
  const g = parseInt(cleanHex.slice(2, 4), 16) / 255;
  const b = parseInt(cleanHex.slice(4, 6), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Get optimal text color (dark or light) for a given background color.
 * Uses WCAG luminance calculation to ensure readable contrast.
 * @param bgColor - Hex color string (e.g., "#FDE2E4")
 * @returns Object with text color classes for primary and secondary text
 */
export function getContrastTextColor(bgColor: string | undefined): {
  primary: string;
  secondary: string;
} {
  if (!bgColor) {
    return {
      primary: "text-slate-600 dark:text-slate-200",
      secondary: "text-slate-400 dark:text-slate-400",
    };
  }

  const luminance = getLuminance(bgColor);
  // Use 0.5 as threshold - colors with luminance below this need light text
  if (luminance < 0.5) {
    return {
      primary: "text-white",
      secondary: "text-white/70",
    };
  }
  return {
    primary: "text-slate-600 dark:text-slate-800",
    secondary: "text-slate-500 dark:text-slate-600",
  };
}

const SECTION_BLOCK_COLORS = [
  "#FDE2E4",
  "#FFD9C9",
  "#FFE8D6",
  "#FFEFD1",
  "#FFF4C1",
  "#EEF6C8",
  "#E6F7D9",
  "#DDF6EE",
  "#D9F0FF",
  "#DEE8FF",
  "#E8E1F5",
];

export type ScheduleRow = {
  id: string;
  kind: "class" | "pool";
  name: string;
  dotColorClass: string;
  slotRows?: ScheduleRow[];
  sectionId?: string;
  sectionName?: string;
  slotLabel?: string;
  locationId?: string;
  locationName?: string;
  blockId?: string;
  blockColor?: string;
  rowBandId?: string;
  colBandId?: string;
  dayType?: DayType;
  rowBandLabel?: string;
  rowBandOrder?: number;
  colBandOrder?: number;
  startTime?: string;
  endTime?: string;
  endDayOffset?: number;
  requiredSlots?: number;
};

type TemplateState = {
  template: WeeklyCalendarTemplate;
  changed: boolean;
  legacySlotIdMap: Record<string, Record<DayType, string>>;
};

export function buildShiftRowId(classId: string, subShiftId: string) {
  return `${classId}${SHIFT_ROW_SEPARATOR}${subShiftId}`;
}

export function getAvailableSubShiftId(usedIds: Set<string>, order: number): string {
  const preferred = `s${order}`;
  if (!usedIds.has(preferred)) return preferred;
  const fallback = ["s1", "s2", "s3"].find((id) => !usedIds.has(id));
  if (fallback) return fallback;
  let suffix = 2;
  let candidate = `${preferred}-${suffix}`;
  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `${preferred}-${suffix}`;
  }
  return candidate;
}

export function parseShiftRowId(rowId: string): { classId: string; subShiftId?: string } {
  const [classId, subShiftId] = rowId.split(SHIFT_ROW_SEPARATOR);
  if (!subShiftId || classId === rowId) {
    return { classId: rowId };
  }
  return { classId, subShiftId };
}

function parseTimeToMinutes(value?: string): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutes(totalMinutes: number): string {
  const clamped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function normalizeSubShifts(subShifts?: SubShift[]): SubShift[] {
  const source = subShifts?.length
    ? subShifts
    : [
        {
          id: "s1",
          name: "Shift 1",
          order: 1,
          startTime: "08:00",
          endTime: "16:00",
          endDayOffset: 0,
          hours: undefined,
        },
      ];
  const usedOrders = new Set<number>();
  const normalized: SubShift[] = [];
  for (const item of source) {
    const rawOrder = item.order;
    let order =
      typeof rawOrder === "number" && rawOrder >= 1 && rawOrder <= 3 ? rawOrder : null;
    if (!order || usedOrders.has(order)) {
      const fallback = [1, 2, 3].find((candidate) => !usedOrders.has(candidate));
      order = fallback ?? 1;
    }
    if (order > 3) continue;
    usedOrders.add(order);
    const id = item.id?.trim() || `s${order}`;
    const name = item.name?.trim() || `Shift ${order}`;
    const rawStart = parseTimeToMinutes(item.startTime);
    const rawEnd = parseTimeToMinutes(item.endTime);
    const rawOffset =
      typeof item.endDayOffset === "number" && Number.isFinite(item.endDayOffset)
        ? Math.max(0, Math.min(3, Math.floor(item.endDayOffset)))
        : 0;
    const legacyHours =
      typeof item.hours === "number" && Number.isFinite(item.hours)
        ? Math.max(0, item.hours)
        : null;
    const fallbackStart =
      DEFAULT_SUB_SHIFT_START_MINUTES + (order - 1) * DEFAULT_SUB_SHIFT_MINUTES;
    const startMinutes = rawStart ?? fallbackStart;
    const durationMinutes = legacyHours !== null ? legacyHours * 60 : DEFAULT_SUB_SHIFT_MINUTES;
    const endMinutes = rawEnd ?? startMinutes + durationMinutes;
    normalized.push({
      id,
      name,
      order: order as 1 | 2 | 3,
      startTime: formatMinutes(startMinutes),
      endTime: formatMinutes(endMinutes),
      endDayOffset: rawOffset,
    });
  }
  if (!normalized.length) {
    normalized.push({
      id: "s1",
      name: "Shift 1",
      order: 1,
      startTime: "08:00",
      endTime: "16:00",
      endDayOffset: 0,
    });
  }
  return normalized.sort((a, b) => a.order - b.order).slice(0, 3);
}

export function ensureLocations(locations?: Location[]): Location[] {
  const next = new Map<string, Location>();
  for (const location of locations ?? []) {
    if (!location?.id) continue;
    next.set(location.id, location);
  }
  if (!next.has(DEFAULT_LOCATION_ID)) {
    next.set(DEFAULT_LOCATION_ID, {
      id: DEFAULT_LOCATION_ID,
      name: DEFAULT_LOCATION_NAME,
    });
  }
  return Array.from(next.values());
}

const DEFAULT_ROW_BAND_LABELS = ["Früh", "Morgen", "Mittag", "Nachmittag", "Spät"];

const createDayTypeBooleanRecord = (value: boolean) =>
  DAY_TYPES.reduce<Record<DayType, boolean>>((acc, dayType) => {
    acc[dayType] = value;
    return acc;
  }, {} as Record<DayType, boolean>);

const createDayTypeNumberRecord = (value: number) =>
  DAY_TYPES.reduce<Record<DayType, number>>((acc, dayType) => {
    acc[dayType] = value;
    return acc;
  }, {} as Record<DayType, number>);

const normalizeDayTypeBooleans = (
  source?: Record<string, boolean>,
  fallback = false,
): Record<DayType, boolean> => {
  const base = createDayTypeBooleanRecord(fallback);
  if (!source) return base;
  for (const dayType of DAY_TYPES) {
    if (typeof source[dayType] === "boolean") {
      base[dayType] = source[dayType];
    }
  }
  return base;
};

const normalizeDayTypeNumbers = (
  source?: Record<string, number>,
  fallback = 0,
): Record<DayType, number> => {
  const base = createDayTypeNumberRecord(fallback);
  if (!source) return base;
  for (const dayType of DAY_TYPES) {
    const value = Number(source[dayType]);
    if (Number.isFinite(value)) {
      base[dayType] = Math.max(0, Math.trunc(value));
    }
  }
  return base;
};

const normalizeTemplateRowBands = (rowBands: TemplateRowBand[]) => {
  const next = [...rowBands].filter((band) => band?.id);
  next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return next.map((band, index) => ({
    ...band,
    order: index + 1,
  }));
};

// Safeguard against colBand explosion - reduced from 50 to 20
const MAX_COLBANDS_PER_DAY = 20;

const normalizeTemplateColBands = (colBands: TemplateColBand[]) => {
  const byDay = new Map<DayType, TemplateColBand[]>();
  for (const band of colBands ?? []) {
    if (!band?.id) continue;
    if (!DAY_TYPES.includes(band.dayType as DayType)) continue;
    const list = byDay.get(band.dayType as DayType) ?? [];
    // SAFEGUARD: Limit colBands per dayType
    if (list.length >= MAX_COLBANDS_PER_DAY) {
      console.error(
        `[normalizeTemplateColBands] BLOCKING colBand explosion: ${list.length} colBands for ${band.dayType}`,
      );
      continue;
    }
    list.push(band);
    byDay.set(band.dayType as DayType, list);
  }
  const normalized: TemplateColBand[] = [];
  for (const dayType of DAY_TYPES) {
    const list = byDay.get(dayType) ?? [];
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    list.forEach((band, index) => {
      normalized.push({
        ...band,
        dayType,
        order: index + 1,
      });
    });
  }
  return normalized;
};

const normalizeSlotTime = (
  slot: TemplateSlot,
): { startTime?: string; endTime?: string; endDayOffset: number } => {
  const start = parseTimeToMinutes(slot.startTime);
  const end = parseTimeToMinutes(slot.endTime);
  const offset =
    typeof slot.endDayOffset === "number" && Number.isFinite(slot.endDayOffset)
      ? Math.max(0, Math.min(3, Math.trunc(slot.endDayOffset)))
      : 0;
  return {
    startTime: start !== null ? formatMinutes(start) : undefined,
    endTime: end !== null ? formatMinutes(end) : undefined,
    endDayOffset: offset,
  };
};

const ensureTemplateLocation = (locationId: string): WeeklyTemplateLocation => ({
  locationId,
  rowBands: DEFAULT_ROW_BAND_LABELS.map((label, index) => ({
    id: `${locationId}-row-${index + 1}`,
    label,
    order: index + 1,
  })),
  colBands: DAY_TYPES.map((dayType) => ({
    id: `${locationId}-col-${dayType}-1`,
    label: "",
    order: 1,
    dayType,
  })),
  slots: [],
});

const buildDefaultTemplateForLocation = (
  locationId: string,
  classRows: WorkplaceRow[],
  minSlotsByRowId: Record<string, MinSlots>,
): { location: WeeklyTemplateLocation; blocks: TemplateBlock[] } => {
  const colBands: TemplateColBand[] = DAY_TYPES.map((dayType) => ({
    id: `${locationId}-col-${dayType}-1`,
    label: "",
    order: 1,
    dayType,
  }));
  let rowIndex = 1;
  const rowBands: TemplateRowBand[] = [];
  const slots: TemplateSlot[] = [];
  const blocks: TemplateBlock[] = [];
  const colBandByDayType = new Map(colBands.map((band) => [band.dayType, band.id]));
  for (const row of classRows) {
    const shifts = normalizeSubShifts(row.subShifts);
    for (const shift of shifts) {
      const rowBandId = `${locationId}-row-${rowIndex}`;
      rowBands.push({
        id: rowBandId,
        label: shift.name,
        order: rowIndex,
      });
      rowIndex += 1;
      const shiftRowId = buildShiftRowId(row.id, shift.id);
      const minSlots = minSlotsByRowId[shiftRowId] ?? { weekday: 0, weekend: 0 };
      const requiredByDayType: Record<DayType, number> = {
        mon: minSlots.weekday,
        tue: minSlots.weekday,
        wed: minSlots.weekday,
        thu: minSlots.weekday,
        fri: minSlots.weekday,
        sat: minSlots.weekend,
        sun: minSlots.weekend,
        holiday: minSlots.weekend,
      };
      for (const dayType of DAY_TYPES) {
        const blockId = `block-${shiftRowId}-${dayType}`;
        blocks.push({
          id: blockId,
          sectionId: row.id,
          label: shift.name,
          requiredSlots: requiredByDayType[dayType] ?? 0,
          color: row.blockColor,
        });
        const colBandId = colBandByDayType.get(dayType);
        if (!colBandId) continue;
        slots.push({
          id: `${shiftRowId}__${dayType}`,
          locationId,
          rowBandId,
          colBandId,
          blockId,
          startTime: shift.startTime,
          endTime: shift.endTime,
          endDayOffset: shift.endDayOffset ?? 0,
        });
      }
    }
  }
  if (rowBands.length === 0) {
    return { location: ensureTemplateLocation(locationId), blocks: [] };
  }
  return { location: { locationId, rowBands, colBands, slots }, blocks };
};

const normalizeWeeklyTemplate = (
  template: WeeklyCalendarTemplate | undefined,
  options: {
    locations: Location[];
    rows: WorkplaceRow[];
    minSlotsByRowId: Record<string, MinSlots>;
  },
): TemplateState => {
  let changed = false;
  const legacySlotIdMap: Record<string, Record<DayType, string>> = {};
  const locationIds = new Set(options.locations.map((loc) => loc.id));
  const classRows = options.rows.filter((row) => row.kind === "class");
  const classById = new Map(classRows.map((row) => [row.id, row]));
  const sectionColorById = new Map(
    classRows
      .filter((row) => row.blockColor)
      .map((row) => [row.id, row.blockColor as string]),
  );
  const minSlotsByRowId = options.minSlotsByRowId;

  if (!template || template.version < 4 || !("blocks" in template)) {
    const blocks: TemplateBlock[] = [];
    const locations: WeeklyTemplateLocation[] = [];
    const normalizeLegacyColBands = (colBands: Array<TemplateColBand | undefined>) => {
      const next = colBands.filter((band) => band?.id) as TemplateColBand[];
      next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return next.map((band, index) => ({
        id: band.id,
        label: band.label ?? "",
        order: index + 1,
        dayType: "mon" as DayType,
      }));
    };
    for (const location of options.locations) {
      const existing = template?.locations?.find(
        (loc) => loc.locationId === location.id,
      );
      if (!existing) {
        const classesForLocation = classRows.filter(
          (row) => (row.locationId ?? DEFAULT_LOCATION_ID) === location.id,
        );
        const built = buildDefaultTemplateForLocation(
          location.id,
          classesForLocation,
          minSlotsByRowId,
        );
        blocks.push(...built.blocks);
        locations.push(built.location);
        changed = true;
        continue;
      }

      const rowBands = normalizeTemplateRowBands(existing.rowBands ?? []);
      if (!rowBands.length) {
        rowBands.push(...ensureTemplateLocation(location.id).rowBands);
        changed = true;
      }
      const legacyColBands = normalizeLegacyColBands(existing.colBands ?? []);
      const baseColBands = legacyColBands.length
        ? legacyColBands
        : [
            {
              id: `${location.id}-col-1`,
              label: "",
              order: 1,
              dayType: "mon" as DayType,
            },
          ];
      const colBands: TemplateColBand[] = [];
      const colBandIdByLegacy = new Map<string, Record<DayType, string>>();
      for (const base of baseColBands) {
        const mapping = {} as Record<DayType, string>;
        for (const dayType of DAY_TYPES) {
          const id = `${base.id}-${dayType}`;
          mapping[dayType] = id;
          colBands.push({
            id,
            label: base.label ?? "",
            order: base.order ?? 1,
            dayType,
          });
        }
        colBandIdByLegacy.set(base.id, mapping);
      }
      const rowBandIds = new Set(rowBands.map((band) => band.id));
      const slots: TemplateSlot[] = [];
      for (const slot of existing.slots ?? []) {
        if (!slot?.id) continue;
        if (!rowBandIds.has(slot.rowBandId)) {
          changed = true;
          continue;
        }
        const sectionId = (slot as unknown as { sectionId?: string }).sectionId;
        if (!sectionId || !classById.has(sectionId)) {
          changed = true;
          continue;
        }
        const enabled = normalizeDayTypeBooleans(
          (slot as unknown as { enabledByDayType?: Record<string, boolean> })
            .enabledByDayType,
          true,
        );
        const required = normalizeDayTypeNumbers(
          (slot as unknown as { requiredByDayType?: Record<string, number> })
            .requiredByDayType,
          0,
        );
        const slotLabel = (slot as unknown as { label?: string }).label?.trim() ?? "";
        const blockTime = normalizeSlotTime(
          slot as unknown as TemplateSlot,
        );
        for (const dayType of DAY_TYPES) {
          if (!enabled[dayType]) continue;
          const blockId = `block-${slot.id}-${dayType}`;
          blocks.push({
            id: blockId,
            sectionId,
            label: slotLabel || undefined,
            requiredSlots: required[dayType] ?? 0,
          });
          const colBandId =
            colBandIdByLegacy.get(slot.colBandId)?.[dayType] ??
            `${location.id}-col-${dayType}-1`;
          const slotId = `${slot.id}__${dayType}`;
          legacySlotIdMap[slot.id] = {
            ...(legacySlotIdMap[slot.id] ?? {}),
            [dayType]: slotId,
          };
          slots.push({
            id: slotId,
            locationId: location.id,
            rowBandId: slot.rowBandId,
            colBandId,
            blockId,
            requiredSlots: required[dayType] ?? 0,
            startTime:
              blockTime.startTime ??
              formatMinutes(DEFAULT_SUB_SHIFT_START_MINUTES),
            endTime:
              blockTime.endTime ??
              formatMinutes(DEFAULT_SUB_SHIFT_START_MINUTES + DEFAULT_SUB_SHIFT_MINUTES),
            endDayOffset: blockTime.endDayOffset,
          });
        }
      }
      if (!legacyColBands.length) {
        changed = true;
      }
      locations.push({
        locationId: location.id,
        rowBands,
        colBands,
        slots,
      });
      changed = true;
    }
    return {
      template: { version: 4, blocks, locations },
      changed: true,
      legacySlotIdMap,
    };
  }

  const blocks: TemplateBlock[] = [];
  const normalizedBlocks = (template.blocks ?? []).filter((block) => block?.id);
  for (const block of normalizedBlocks) {
    if (!classById.has(block.sectionId)) {
      changed = true;
      continue;
    }
    const requiredSlots = Number.isFinite(block.requiredSlots)
      ? Math.max(0, Math.trunc(block.requiredSlots))
      : 0;
    const trimmedColor =
      typeof block.color === "string" ? block.color.trim() : undefined;
    const color = trimmedColor ? trimmedColor : undefined;
    const sectionColor = sectionColorById.get(block.sectionId);
    const normalizedBlock: TemplateBlock = {
      ...block,
      requiredSlots,
      color: sectionColor ?? color,
    };
    if (normalizedBlock.requiredSlots !== block.requiredSlots) {
      changed = true;
    }
    if (normalizedBlock.color !== block.color) {
      changed = true;
    }
    blocks.push(normalizedBlock);
  }
  const blockIds = new Set(blocks.map((block) => block.id));
  const blockById = new Map(blocks.map((block) => [block.id, block]));

  const nextLocations: WeeklyTemplateLocation[] = [];
  for (const location of options.locations) {
    const existing = template.locations?.find((loc) => loc.locationId === location.id);
    if (!existing) {
      nextLocations.push(ensureTemplateLocation(location.id));
      changed = true;
      continue;
    }
    const rowBands = normalizeTemplateRowBands(existing.rowBands ?? []);
    if (!rowBands.length) {
      rowBands.push(...ensureTemplateLocation(location.id).rowBands);
      changed = true;
    }
    let colBands = normalizeTemplateColBands(existing.colBands ?? []);
    const colBandsByDay = new Map<DayType, TemplateColBand[]>();
    for (const band of colBands) {
      const list = colBandsByDay.get(band.dayType) ?? [];
      list.push(band);
      colBandsByDay.set(band.dayType, list);
    }
    for (const dayType of DAY_TYPES) {
      if ((colBandsByDay.get(dayType) ?? []).length > 0) continue;
      colBands.push({
        id: `${location.id}-col-${dayType}-1`,
        label: "",
        order: 1,
        dayType,
      });
      changed = true;
    }
    colBands = normalizeTemplateColBands(colBands);
    const rowBandIds = new Set(rowBands.map((band) => band.id));
    const colBandIds = new Set(colBands.map((band) => band.id));
    const slots: TemplateSlot[] = [];
    for (const slot of existing.slots ?? []) {
      if (!slot?.id) continue;
      if (!rowBandIds.has(slot.rowBandId) || !colBandIds.has(slot.colBandId)) {
        changed = true;
        continue;
      }
      if (!blockIds.has(slot.blockId)) {
        changed = true;
        continue;
      }
      const time = normalizeSlotTime(slot);
      const rawRequired = (slot as unknown as { requiredSlots?: number | string })
        .requiredSlots;
      const parsedRequired = Number(rawRequired);
      const requiredSlots = Number.isFinite(parsedRequired)
        ? Math.max(0, Math.trunc(parsedRequired))
        : Math.max(0, blockById.get(slot.blockId)?.requiredSlots ?? 0);
      const normalizedSlot: TemplateSlot = {
        ...slot,
        locationId: location.id,
        requiredSlots,
        ...time,
      };
      if (normalizedSlot.locationId !== slot.locationId) {
        changed = true;
      }
      if (
        (slot as unknown as { requiredSlots?: number }).requiredSlots !== requiredSlots
      ) {
        changed = true;
      }
      slots.push(normalizedSlot);
    }
    nextLocations.push({
      locationId: location.id,
      rowBands,
      colBands,
      slots,
    });
  }

  if (template.locations?.some((loc) => !locationIds.has(loc.locationId))) {
    changed = true;
  }

  return {
    template: { version: 4, blocks, locations: nextLocations },
    changed,
    legacySlotIdMap,
  };
};

export function normalizeAppState(state: AppState): { state: AppState; changed: boolean } {
  let changed = false;
  const locationsEnabled = state.locationsEnabled !== false;
  if (state.locationsEnabled !== locationsEnabled) {
    changed = true;
  }
  // Migration: Remove deprecated pool rows (Distribution Pool and Reserve Pool)
  let baseRows = [...(state.rows ?? [])].filter(
    (row) => !DEPRECATED_POOL_IDS.has(row.id),
  );
  if (baseRows.length !== (state.rows ?? []).length) {
    changed = true;
  }
  const hasRestDayPool = baseRows.some((row) => row.id === REST_DAY_POOL_ID);
  if (!hasRestDayPool) {
    const restDayRow: WorkplaceRow = {
      id: REST_DAY_POOL_ID,
      name: "Rest Day",
      kind: "pool",
      dotColorClass: "bg-slate-200",
    };
    baseRows = [...baseRows, restDayRow];
    changed = true;
  }
  if (Array.isArray(state.weeklyTemplate?.blocks)) {
    const blockSectionIds = new Set(
      state.weeklyTemplate.blocks
        .map((block) => block.sectionId)
        .filter((id): id is string => Boolean(id)),
    );
    const nextBaseRows = baseRows.filter(
      (row) => row.kind !== "class" || blockSectionIds.has(row.id),
    );
    if (nextBaseRows.length !== baseRows.length) {
      baseRows = nextBaseRows;
      changed = true;
    }
  }
  const defaultSolverSettings = {
    enforceSameLocationPerDay: true,
    onCallRestEnabled: false,
    onCallRestClassId: "",
    onCallRestDaysBefore: 1,
    onCallRestDaysAfter: 1,
    preferContinuousShifts: true,
    scheduleLayout: "classic" as ScheduleLayout,
  };
  // Remove deprecated settings during migration
  const {
    showDistributionPool: _,
    showReservePool: __,
    allowMultipleShiftsPerDay: ___,
    ...cleanedSettings
  } = (state.solverSettings ?? {}) as Record<string, unknown>;
  const solverSettings = {
    ...defaultSolverSettings,
    ...cleanedSettings,
  };
  const classIds = baseRows
    .filter((row) => row.kind === "class")
    .map((row) => row.id);
  if (!solverSettings.onCallRestClassId || !classIds.includes(solverSettings.onCallRestClassId)) {
    solverSettings.onCallRestClassId = classIds[0] ?? "";
  }
  const clampDays = (value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(0, Math.min(7, Math.trunc(parsed)));
  };
  solverSettings.onCallRestDaysBefore = clampDays(solverSettings.onCallRestDaysBefore);
  solverSettings.onCallRestDaysAfter = clampDays(solverSettings.onCallRestDaysAfter);
  if (solverSettings.scheduleLayout !== "clinicSheet") {
    solverSettings.scheduleLayout = "classic";
  }
  if (JSON.stringify(solverSettings) !== JSON.stringify(state.solverSettings ?? {})) {
    changed = true;
  }
  const locations = ensureLocations(state.locations);
  if (!state.locations || state.locations.length !== locations.length) {
    changed = true;
  }
  const locationIdSet = new Set(locations.map((loc) => loc.id));

  const clinicians = (state.clinicians ?? []).map((clinician) => {
    const preferredWorkingTimes = normalizePreferredWorkingTimes(
      clinician.preferredWorkingTimes,
    );
    if (
      JSON.stringify(preferredWorkingTimes) !==
      JSON.stringify(clinician.preferredWorkingTimes ?? {})
    ) {
      changed = true;
    }
    // Mirror of the backend cap: trimmed, max 500 chars, empty -> absent.
    const planningWishes =
      clinician.planningWishes?.trim().slice(0, 500) || undefined;
    if (planningWishes !== clinician.planningWishes) {
      changed = true;
    }
    return { ...clinician, preferredWorkingTimes, planningWishes };
  });

  let classIndex = 0;
  const rows = baseRows.map((row) => {
    if (row.kind !== "class") return row;
    const normalizedShifts = normalizeSubShifts(row.subShifts);
    const usedSubShiftIds = new Set<string>();
    const subShifts = normalizedShifts.map((shift) => {
      const baseId = shift.id?.trim() || `s${shift.order}`;
      if (!usedSubShiftIds.has(baseId)) {
        usedSubShiftIds.add(baseId);
        return baseId === shift.id ? shift : { ...shift, id: baseId };
      }
      const nextId = getAvailableSubShiftId(usedSubShiftIds, shift.order);
      usedSubShiftIds.add(nextId);
      changed = true;
      return { ...shift, id: nextId };
    });
    let locationId =
      row.locationId && locationIdSet.has(row.locationId)
        ? row.locationId
        : DEFAULT_LOCATION_ID;
    if (!locationsEnabled && locationId !== DEFAULT_LOCATION_ID) {
      locationId = DEFAULT_LOCATION_ID;
      changed = true;
    }
    const trimmedBlockColor =
      typeof row.blockColor === "string" ? row.blockColor.trim() : "";
    const blockColor =
      trimmedBlockColor ||
      SECTION_BLOCK_COLORS[classIndex % SECTION_BLOCK_COLORS.length];
    classIndex += 1;
    if (
      row.locationId !== locationId ||
      !row.subShifts ||
      row.subShifts.length !== subShifts.length ||
      row.blockColor !== blockColor
    ) {
      changed = true;
    }
    return { ...row, locationId, subShifts, blockColor };
  });

  const classRows = rows.filter((row) => row.kind === "class");
  const classRowIds = new Set(classRows.map((row) => row.id));
  const rowIds = new Set(rows.map((row) => row.id));
  const fallbackShiftIdByClass = new Map(
    classRows.map((row) => [row.id, (row.subShifts ?? [])[0]?.id ?? "s1"]),
  );
  const subShiftIdsByClass = new Map(
    classRows.map((row) => [
      row.id,
      new Set((row.subShifts ?? []).map((shift) => shift.id)),
    ]),
  );

  const rawSlotIds = new Set(
    state.weeklyTemplate?.locations.flatMap((location) =>
      location.slots.map((slot) => slot.id),
    ) ?? [],
  );
  const assignments: Assignment[] = [];
  for (const assignment of state.assignments ?? []) {
    // Migration: Skip assignments to deprecated pools
    if (DEPRECATED_POOL_IDS.has(assignment.rowId)) {
      changed = true;
      continue;
    }
    let rowId = assignment.rowId;
    if (classRowIds.has(rowId) && !rowId.includes(SHIFT_ROW_SEPARATOR)) {
      const fallback = fallbackShiftIdByClass.get(rowId) ?? "s1";
      rowId = buildShiftRowId(rowId, fallback);
      changed = true;
    }
    if (rowId.includes(SHIFT_ROW_SEPARATOR)) {
      const { classId, subShiftId } = parseShiftRowId(rowId);
      if (!classId || !classRowIds.has(classId)) {
        changed = true;
        continue;
      }
      const classShiftIds = subShiftIdsByClass.get(classId);
      if (!subShiftId || !classShiftIds?.has(subShiftId)) {
        const fallback = classShiftIds ? Array.from(classShiftIds)[0] : undefined;
        if (!fallback) {
          changed = true;
          continue;
        }
        rowId = buildShiftRowId(classId, fallback);
        changed = true;
      }
      assignments.push({ ...assignment, rowId });
      continue;
    }
    if (
      classRowIds.has(rowId) ||
      rowId.startsWith("pool-") ||
      rowIds.has(rowId) ||
      rawSlotIds.has(rowId)
    ) {
      assignments.push({ ...assignment, rowId });
    } else {
      changed = true;
    }
  }

  const minSlotsByRowId: Record<string, MinSlots> = {
    ...(state.minSlotsByRowId ?? {}),
  };
  for (const row of classRows) {
    const base = minSlotsByRowId[row.id];
    if (base) {
      delete minSlotsByRowId[row.id];
      changed = true;
    }
    for (const shift of row.subShifts ?? []) {
      const shiftRowId = buildShiftRowId(row.id, shift.id);
      if (!minSlotsByRowId[shiftRowId]) {
        minSlotsByRowId[shiftRowId] =
          shift.id === "s1" && base ? base : { weekday: 0, weekend: 0 };
        changed = true;
      }
    }
  }
  for (const key of Object.keys(minSlotsByRowId)) {
    if (!key.includes(SHIFT_ROW_SEPARATOR)) continue;
    const { classId, subShiftId } = parseShiftRowId(key);
    const valid = subShiftId && subShiftIdsByClass.get(classId)?.has(subShiftId);
    if (!valid) {
      delete minSlotsByRowId[key];
      changed = true;
    }
  }

  const overrides = state.slotOverridesByKey ?? {};
  const slotOverridesByKey: Record<string, number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    // Keys are `${rowId}__${dateISO}` where rowId may itself contain "__"
    // (migrated slot ids like "class-1::s1__mon"), so split at the last "__".
    const separatorIndex = key.lastIndexOf("__");
    const rowId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
    const dateISO = separatorIndex >= 0 ? key.slice(separatorIndex + 2) : "";
    if (!rowId || !dateISO) continue;
    // Migrated slot ids carry a `__${dayType}` suffix; they are already in
    // slot-id form and must not be remapped as legacy shift-row ids.
    const slotIdParts = rowId.split("__");
    const isTemplateSlotId =
      slotIdParts.length === 2 && DAY_TYPES.includes(slotIdParts[1] as DayType);
    let nextRowId = rowId;
    if (isTemplateSlotId) {
      // Keep as-is; validated against the template's slot ids below.
    } else if (classRowIds.has(rowId) && !rowId.includes(SHIFT_ROW_SEPARATOR)) {
      nextRowId = buildShiftRowId(rowId, "s1");
      changed = true;
    } else if (rowId.includes(SHIFT_ROW_SEPARATOR)) {
      const { classId, subShiftId } = parseShiftRowId(rowId);
      const classShiftIds = subShiftIdsByClass.get(classId);
      if (!subShiftId || !classShiftIds) {
        changed = true;
        continue;
      }
      if (!classShiftIds.has(subShiftId)) {
        const fallback = Array.from(classShiftIds)[0];
        if (!fallback) {
          changed = true;
          continue;
        }
        nextRowId = buildShiftRowId(classId, fallback);
        changed = true;
      }
    }
    const nextKey = `${nextRowId}__${dateISO}`;
    slotOverridesByKey[nextKey] = (slotOverridesByKey[nextKey] ?? 0) + value;
  }
  if (Object.keys(overrides).length !== Object.keys(slotOverridesByKey).length) {
    changed = true;
  }

  const templateState = normalizeWeeklyTemplate(state.weeklyTemplate, {
    locations,
    rows,
    minSlotsByRowId,
  });
  if (templateState.changed) {
    changed = true;
  }
  const holidaySet = new Set((state.holidays ?? []).map((holiday) => holiday.dateISO));
  const slotIds = new Set(
    templateState.template.locations.flatMap((location) =>
      location.slots.map((slot) => slot.id),
    ),
  );
  const blockById = new Map(
    (templateState.template.blocks ?? []).map((block) => [block.id, block]),
  );
  const slotMetaById = new Map<
    string,
    { dayType?: DayType; valid: boolean }
  >();
  for (const location of templateState.template.locations ?? []) {
    const colBandById = new Map(
      (location.colBands ?? []).map((band) => [band.id, band]),
    );
    for (const slot of location.slots ?? []) {
      const block = blockById.get(slot.blockId);
      const valid = Boolean(block && classRowIds.has(block.sectionId));
      const dayType = colBandById.get(slot.colBandId)?.dayType;
      slotMetaById.set(slot.id, { dayType, valid });
    }
  }
  const slotIdMapByLegacyKey: Record<string, Record<DayType, string>> = {
    ...templateState.legacySlotIdMap,
  };
  for (const slotId of slotIds) {
    const parts = slotId.split("__");
    if (parts.length !== 2) continue;
    const [baseId, dayType] = parts;
    if (!baseId || !DAY_TYPES.includes(dayType as DayType)) continue;
    slotIdMapByLegacyKey[baseId] = {
      ...(slotIdMapByLegacyKey[baseId] ?? {}),
      [dayType as DayType]: slotId,
    };
  }
  const poolRowIds = new Set(rows.filter((row) => row.kind === "pool").map((row) => row.id));

  const resolveLegacySlotId = (rowId: string, dateISO: string) => {
    const mapping = slotIdMapByLegacyKey[rowId];
    if (!mapping) return rowId;
    const dayType = getDayType(dateISO, holidaySet);
    return mapping[dayType] ?? null;
  };

  const mappedAssignments: Assignment[] = [];
  for (const assignment of assignments) {
    if (poolRowIds.has(assignment.rowId)) {
      mappedAssignments.push(assignment);
      continue;
    }
    let nextRowId = assignment.rowId;
    if (!slotIds.has(nextRowId)) {
      const mapped = resolveLegacySlotId(nextRowId, assignment.dateISO);
      if (!mapped) {
        changed = true;
        continue;
      }
      nextRowId = mapped;
      changed = true;
    }
    if (!slotIds.has(nextRowId)) {
      changed = true;
      continue;
    }
    const meta = slotMetaById.get(nextRowId);
    if (!meta?.valid) {
      // Invalid assignment - remove it (no longer moved to Distribution Pool)
      changed = true;
      continue;
    }
    const assignmentDayType = getDayType(assignment.dateISO, holidaySet);
    if (meta.dayType && meta.dayType !== assignmentDayType) {
      // Day type mismatch - remove assignment (no longer moved to Distribution Pool)
      changed = true;
      continue;
    }
    mappedAssignments.push(
      nextRowId === assignment.rowId ? assignment : { ...assignment, rowId: nextRowId },
    );
  }

  const filteredOverrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(slotOverridesByKey)) {
    const separatorIndex = key.lastIndexOf("__");
    const rowId = separatorIndex >= 0 ? key.slice(0, separatorIndex) : key;
    const dateISO = separatorIndex >= 0 ? key.slice(separatorIndex + 2) : "";
    if (!rowId || !dateISO) continue;
    let nextRowId = rowId;
    if (!slotIds.has(nextRowId)) {
      const mapped = resolveLegacySlotId(nextRowId, dateISO);
      if (!mapped) {
        changed = true;
        continue;
      }
      nextRowId = mapped;
      changed = true;
    }
    if (!slotIds.has(nextRowId)) {
      changed = true;
      continue;
    }
    const nextKey = `${nextRowId}__${dateISO}`;
    filteredOverrides[nextKey] = (filteredOverrides[nextKey] ?? 0) + value;
  }
  if (mappedAssignments.length !== assignments.length) {
    changed = true;
  }

  const normalizedRules = (state.solverRules ?? []).map((rule) => {
    if (!rule || typeof rule !== "object") return rule;
    if (!rule.ifShiftRowId || !slotIds.has(rule.ifShiftRowId)) {
      return { ...rule, enabled: false };
    }
    if (rule.thenType === "shiftRow" && rule.thenShiftRowId) {
      if (!slotIds.has(rule.thenShiftRowId)) {
        return { ...rule, enabled: false };
      }
    }
    return rule;
  });
  if (JSON.stringify(normalizedRules) !== JSON.stringify(state.solverRules ?? [])) {
    changed = true;
  }

  return {
    state: {
      ...state,
      locationsEnabled,
      locations,
      rows,
      clinicians,
      assignments: mappedAssignments,
      minSlotsByRowId,
      slotOverridesByKey: filteredOverrides,
      solverSettings,
      solverRules: normalizedRules,
      weeklyTemplate: templateState.template,
    },
    changed,
  };
}

export function buildScheduleRows(
  rows: WorkplaceRow[],
  locations: Location[],
  locationsEnabled = true,
  weeklyTemplate?: WeeklyCalendarTemplate,
): ScheduleRow[] {
  const locationNameById = new Map(locations.map((loc) => [loc.id, loc.name]));
  const scheduleRows: ScheduleRow[] = [];
  const classRows = rows.filter((row) => row.kind === "class");
  const sectionById = new Map(classRows.map((row) => [row.id, row]));

  if (weeklyTemplate) {
    const blockById = new Map(
      (weeklyTemplate.blocks ?? []).map((block) => [block.id, block]),
    );
    const dayOrder = new Map(DAY_TYPES.map((dayType, index) => [dayType, index]));
    for (const templateLocation of weeklyTemplate.locations ?? []) {
      const rowBands = [...(templateLocation.rowBands ?? [])].sort(
        (a, b) => a.order - b.order,
      );
      const colBands = [...(templateLocation.colBands ?? [])].sort(
        (a, b) => a.order - b.order,
      );
      const rowBandById = new Map(rowBands.map((band) => [band.id, band]));
      const colBandById = new Map(colBands.map((band) => [band.id, band]));
      const slots = [...(templateLocation.slots ?? [])];
      slots.sort((a, b) => {
        const rowOrder =
          (rowBandById.get(a.rowBandId)?.order ?? 0) -
          (rowBandById.get(b.rowBandId)?.order ?? 0);
        if (rowOrder !== 0) return rowOrder;
        const dayOrderA =
          dayOrder.get(colBandById.get(a.colBandId)?.dayType ?? "mon") ?? 0;
        const dayOrderB =
          dayOrder.get(colBandById.get(b.colBandId)?.dayType ?? "mon") ?? 0;
        if (dayOrderA !== dayOrderB) return dayOrderA - dayOrderB;
        return (
          (colBandById.get(a.colBandId)?.order ?? 0) -
          (colBandById.get(b.colBandId)?.order ?? 0)
        );
      });
      for (const slot of slots) {
        const block = blockById.get(slot.blockId);
        if (!block) continue;
        const section = sectionById.get(block.sectionId);
        if (!section) continue;
        const locationId = locationsEnabled ? slot.locationId : DEFAULT_LOCATION_ID;
        const colBand = colBandById.get(slot.colBandId);
        scheduleRows.push({
          id: slot.id,
          kind: "class",
          name: section.name,
          dotColorClass: section.dotColorClass,
          sectionId: section.id,
          sectionName: section.name,
          slotLabel: block.label,
          locationId,
          locationName: locationsEnabled
            ? locationNameById.get(locationId) ?? DEFAULT_LOCATION_NAME
            : undefined,
          blockId: slot.blockId,
          blockColor: section.blockColor ?? block.color,
          rowBandId: slot.rowBandId,
          colBandId: slot.colBandId,
          dayType: colBand?.dayType,
          rowBandLabel: rowBandById.get(slot.rowBandId)?.label,
          rowBandOrder: rowBandById.get(slot.rowBandId)?.order,
          colBandOrder: colBand?.order,
          startTime: slot.startTime,
          endTime: slot.endTime,
          endDayOffset: slot.endDayOffset,
          requiredSlots: slot.requiredSlots,
        });
      }
    }
    for (const row of rows) {
      if (row.kind === "pool") {
        scheduleRows.push({
          id: row.id,
          kind: row.kind,
          name: row.name,
          dotColorClass: row.dotColorClass,
          blockColor: row.blockColor,
        });
      }
    }
    return scheduleRows;
  }

  for (const row of rows) {
    if (row.kind !== "class") {
      scheduleRows.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        dotColorClass: row.dotColorClass,
      });
      continue;
    }
    const subShifts = normalizeSubShifts(row.subShifts);
    const locationName = locationsEnabled
      ? (row.locationId && locationNameById.get(row.locationId)) ??
        locationNameById.get(DEFAULT_LOCATION_ID)
      : undefined;
    for (const shift of subShifts) {
      scheduleRows.push({
        id: buildShiftRowId(row.id, shift.id),
        kind: "class",
        name: row.name,
        dotColorClass: row.dotColorClass,
        sectionId: row.id,
        sectionName: row.name,
        slotLabel: shift.name,
        locationId: row.locationId,
        locationName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        endDayOffset: shift.endDayOffset,
      });
    }
  }
  return scheduleRows;
}
