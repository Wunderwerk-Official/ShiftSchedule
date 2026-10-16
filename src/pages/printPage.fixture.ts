import type { AppState } from "../api/client";
import {
  clinicians,
  defaultSolverSettings,
  locations,
  weeklyTemplate,
  workplaceRows,
} from "../data/mockData";

// Calendar for the print page tests (frontend-only: the frontend Docker build
// copies src/ but not backend/). Monday has an early and a late column, so
// the side-by-side grid has more columns than days.
export function printTestState(): AppState {
  const [location] = weeklyTemplate.locations;
  const [slot] = location.slots;
  return {
    locations,
    locationsEnabled: true,
    rows: workplaceRows,
    clinicians,
    assignments: [],
    minSlotsByRowId: {},
    slotOverridesByKey: {},
    holidays: [],
    solverSettings: { ...defaultSolverSettings, scheduleLayout: "classic" },
    weeklyTemplate: {
      ...weeklyTemplate,
      locations: [
        {
          ...location,
          colBands: [...location.colBands, { id: "col-mon-2", label: "", order: 2, dayType: "mon" }],
          slots: [
            ...location.slots,
            { ...slot, id: "slot-mri-mon-2", colBandId: "col-mon-2", startTime: "16:00", endTime: "22:00" },
          ],
        },
      ],
    },
  } as AppState;
}
