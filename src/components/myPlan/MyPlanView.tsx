import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Assignment,
  Clinician,
  Holiday,
  Location,
  Orientation,
  PlanRange,
  PlanScope,
  SolverSettings,
  UserPreferences,
  ViewConfig,
} from "../../api/client";
import { toISODate } from "../../lib/date";
import {
  findNextShiftFor,
  formatPeriodLabel,
  isoWeekNumber,
  parseISODate,
  personColor,
  type PlanShift,
  type PlanSource,
} from "../../lib/myPlan";
import type { ScheduleRow } from "../../lib/shiftRows";
import type { PreferencesUpdate } from "../../lib/userPreferences";
import DayLeftView from "./DayLeftView";
import DayTopView from "./DayTopView";
import LinkClinicianCard from "./LinkClinicianCard";
import MonthCalendarView from "./MonthCalendarView";
import MonthListView from "./MonthListView";
import NextUpChip from "./NextUpChip";
import OrientationSwitch from "./OrientationSwitch";
import PeriodNavigator from "./PeriodNavigator";
import PersonPicker from "./PersonPicker";
import PlanFooter from "./PlanFooter";
import PlanHeader, { ViewingBanner } from "./PlanHeader";
import PlanScopeSwitch from "./PlanScopeSwitch";
import RangeSwitch from "./RangeSwitch";
import SavedViewsMenu from "./SavedViewsMenu";
import ShiftDetail from "./ShiftDetail";
import StartPageStar from "./StartPageStar";
import Toast, { useToast } from "./Toast";
import type { PlanViewProps, SelectShift, TeamPlanTarget } from "./types";
import { useMinuteClock } from "./useMinuteClock";
import { useMyPlanData, visibleRange } from "./useMyPlanData";
import { adjacentShift, defaultDayShiftId, findShift, footerSummary } from "./planSummary";
import { SHORTCUT_HELP, usePlanShortcuts } from "./usePlanShortcuts";
import { displayName, initialsOf } from "./planChrome";
import {
  applyViewConfig,
  currentViewConfig,
  orientationOf,
  orientationUpdate,
  rangeOf,
  rangeUpdate,
  viewStartDate,
} from "./viewConfig";
import WeekLeftView from "./WeekLeftView";
import WeekTopView from "./WeekTopView";

// "My plan" container (plan §4.2): builds the viewed person's plan for the
// visible range, owns selection / viewed person / clock, and renders the
// header, the active view (week/day/month × date on top/left), the shift
// detail and the footer inside the same card chrome as the team grid.

export type { TeamPlanTarget } from "./types";

/**
 * Props of the container. Performance: the plan builders (buildPersonPlan,
 * day lanes with a coworker lookup per shift) are memoized on the seven data
 * slices below, so pass STABLE references — the page's normalized state
 * arrays and solverSettings object, not new arrays/objects per render —
 * or every page render rebuilds every plan.
 */
export type MyPlanViewProps = {
  scheduleRows: ScheduleRow[];
  assignments: Assignment[];
  clinicians: Clinician[];
  locations: Location[];
  holidays: Holiday[];
  publishedWeekStartISOs: string[];
  solverSettings?: SolverSettings;
  anchorDate: Date;
  onAnchorDateChange: (date: Date) => void;
  isMobile: boolean;
  isDark: boolean;
  prefs: UserPreferences;
  /** useUserPreferences().update — a patch or an updater. */
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  /** useUserPreferences().loaded; while false the "Who are you?" card is not shown. */
  prefsLoaded?: boolean;
  currentScope: PlanScope;
  onScopeChange: (scope: PlanScope) => void;
  /** "Show in team plan": switch to the team scope at that date, jump to the row and pulse the pill. */
  onShowInTeam: (target: TeamPlanTarget) => void;
  /** Page controls shown right of header row 1 (before the star). */
  headerExtras?: ReactNode;
};

export default function MyPlanView(props: MyPlanViewProps) {
  const {
    scheduleRows, assignments, clinicians, locations, holidays, publishedWeekStartISOs, solverSettings,
    anchorDate, onAnchorDateChange, isMobile, isDark, prefs, onUpdatePrefs, prefsLoaded = true,
    currentScope, onScopeChange, onShowInTeam, headerExtras,
  } = props;
  const now = useMinuteClock();
  const todayISO = toISODate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { toast, show: notify, dismiss: dismissToast } = useToast();

  const source = useMemo<PlanSource>(
    () => ({ scheduleRows, assignments, clinicians, locations, holidays, publishedWeekStartISOs, solverSettings }),
    [scheduleRows, assignments, clinicians, locations, holidays, publishedWeekStartISOs, solverSettings],
  );
  const locationsById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations]);
  const clinicianIndex = useMemo(() => new Map(clinicians.map((c, index) => [c.id, index])), [clinicians]);

  const linkedId = prefs.clinicianId && clinicianIndex.has(prefs.clinicianId) ? prefs.clinicianId : null;
  const [viewedOverride, setViewedOverride] = useState<string | null>(null);
  const viewedId = viewedOverride && clinicianIndex.has(viewedOverride) ? viewedOverride : linkedId;
  const viewed = viewedId ? clinicians[clinicianIndex.get(viewedId) ?? -1] : undefined;
  const viewingOther = !!viewedId && viewedId !== linkedId;

  const range = rangeOf(prefs, isMobile);
  const orientation = orientationOf(prefs, range, isMobile);
  const data = useMyPlanData({ source, locationsById, viewedId, myClinicianId: linkedId, range, anchorDate, todayISO });
  const { plan, dayLanes } = data;

  // The selection belongs to the period and person it was made in: paging,
  // switching range or person drops it (no detail popping up on return).
  const periodKey = `${viewedId}|${range}|${data.fromISO}`;
  const [selected, setSelected] = useState<{ shiftId: string; anchor: HTMLElement | null; periodKey: string } | null>(
    null,
  );
  const selection = selected?.periodKey === periodKey ? selected : null;
  const selectShift = useCallback(
    (shiftId: string | null, anchor?: HTMLElement | null) => {
      setSelected(shiftId ? { shiftId, anchor: anchor ?? null, periodKey } : null);
    },
    [periodKey],
  );
  const closeDetail = useCallback(() => setSelected(null), []);

  const setRange = (next: PlanRange) => onUpdatePrefs(rangeUpdate(next, isMobile));
  const setOrientation = (next: Orientation) => onUpdatePrefs(orientationUpdate(range, next, isMobile));
  // "Open day" (month popover / list rows) unmounts the control that had focus:
  // focus then moves to the plan body, which now shows that day.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyFocusRequest, setBodyFocusRequest] = useState(0);
  useEffect(() => {
    if (bodyFocusRequest === 0) return;
    const active = document.activeElement;
    if (!active || active === document.body) bodyRef.current?.focus({ preventScroll: true });
  }, [bodyFocusRequest]);
  const openDay = (dateISO: string) => {
    onAnchorDateChange(parseISODate(dateISO));
    onUpdatePrefs(rangeUpdate("day", isMobile));
    setBodyFocusRequest((count) => count + 1);
  };
  const showInTeam = (shift: PlanShift) => {
    setSelected(null);
    onShowInTeam({ rowId: shift.rowId, dateISO: shift.dateISO, clinicianId: shift.clinicianId });
  };
  const pickPerson = (clinicianId: string) => setViewedOverride(clinicianId === linkedId ? null : clinicianId);
  // Saved views open at their relative start (today / next shift / week start).
  const applyView = (view: ViewConfig) => {
    applyViewConfig(view, onScopeChange, onUpdatePrefs, isMobile);
    const start = viewStartDate(view, new Date(), () =>
      viewedId ? findNextShiftFor(source, viewedId, new Date())?.shift.dateISO ?? null : null,
    );
    if (start) onAnchorDateChange(start);
  };
  const currentView = currentViewConfig(prefs, currentScope, isMobile);

  // Day views show the detail as a card: desktop in both orientations (a
  // column / below the lanes), phones in day · date on left (SPEC E12; the
  // phone day · top keeps its colleague list and the sheet).
  const inlineDayDetail = range === "day" && (!isMobile || orientation === "left");
  // The card shows the selection, else the day's running/next own shift (preselected).
  const fallbackId =
    plan && inlineDayDetail ? defaultDayShiftId(plan, data.fromISO, todayISO, nowMin) : null;

  // "N" / "Shift+N": from the selected shift, else from now (today visible) or the period start.
  const jumpToShift = (direction: 1 | -1) => {
    if (!plan) return;
    const currentId = selection?.shiftId ?? fallbackId;
    const current = currentId ? findShift([plan], currentId)?.shift : undefined;
    const todayShown = data.fromISO <= todayISO && todayISO <= data.toISO;
    const ref = current
      ? { dateISO: current.dateISO, min: current.startMin }
      : { dateISO: todayShown ? todayISO : data.fromISO, min: todayShown ? nowMin : 0 };
    const target = adjacentShift(plan, ref.dateISO, ref.min, direction);
    if (!target) return;
    const targetFrom = visibleRange(range, parseISODate(target.dateISO)).fromISO;
    if (targetFrom !== data.fromISO) onAnchorDateChange(parseISODate(target.dateISO));
    setSelected({ shiftId: target.id, anchor: null, periodKey: `${viewedId}|${range}|${targetFrom}` });
  };
  usePlanShortcuts({
    day: () => setRange("day"),
    week: () => setRange("week"),
    month: () => setRange("month"),
    today: () => onAnchorDateChange(new Date()),
    orientation: () => setOrientation(orientation === "top" ? "left" : "top"),
    scope: () => onScopeChange("team"),
    nextShift: () => jumpToShift(1),
    previousShift: () => jumpToShift(-1),
    help: () => notify(SHORTCUT_HELP),
  });

  // SPEC R18: the browser title names whose plan is shown ("Plan of Jonas Weber · Week 42").
  const otherName = viewingOther && viewed ? viewed.name : null;
  const anchorWeek = isoWeekNumber(anchorDate);
  useEffect(() => {
    if (!otherName) return;
    const previous = document.title;
    document.title = `Plan of ${otherName} · Week ${anchorWeek}`;
    return () => {
      document.title = previous;
    };
  }, [otherName, anchorWeek]);

  const viewedIndex = viewedId ? clinicianIndex.get(viewedId) ?? 0 : 0;
  const header = (
    <PlanHeader
      isMobile={isMobile}
      scopeSwitch={
        <PlanScopeSwitch
          scope={currentScope}
          onChange={onScopeChange}
          meInitials={viewed ? initialsOf(viewed.name) : undefined}
          meColor={viewed ? personColor(viewedIndex).strong : undefined}
          meLabel={viewingOther && viewed ? viewed.name : "My plan"}
          compact={isMobile}
        />
      }
      personPicker={
        clinicians.length > 0 ? (
          <PersonPicker
            clinicians={clinicians}
            viewedId={viewedId}
            myId={linkedId}
            onChange={pickPerson}
            isMobile={isMobile}
          />
        ) : null
      }
      nextUp={
        viewedId ? (
          <NextUpChip
            source={source}
            clinicianId={viewedId}
            now={now}
            onOpenDay={openDay}
            isMobile={isMobile}
            isDark={isDark}
            forName={viewingOther && viewed ? displayName(viewed.name).split(" ")[0] : undefined}
          />
        ) : null
      }
      extras={headerExtras}
      star={
        <StartPageStar
          currentView={currentView}
          prefs={prefs}
          onUpdatePrefs={onUpdatePrefs}
          isMobile={isMobile}
          onNotify={notify}
        />
      }
      views={
        <SavedViewsMenu
          currentView={currentView}
          prefs={prefs}
          onUpdatePrefs={onUpdatePrefs}
          onApplyView={applyView}
          isMobile={isMobile}
          onNotify={notify}
        />
      }
      navigator={
        <PeriodNavigator
          range={range}
          anchorDate={anchorDate}
          onChange={onAnchorDateChange}
          todayVisible={data.fromISO <= todayISO && todayISO <= data.toISO}
          isMobile={isMobile}
        />
      }
      rangeSwitch={<RangeSwitch range={range} onChange={setRange} isMobile={isMobile} />}
      orientationSwitch={
        <OrientationSwitch range={range} orientation={orientation} onChange={setOrientation} compact={isMobile} />
      }
    />
  );

  let body: ReactNode = null;
  let detail: ReactNode = null;
  if (!plan) {
    body = prefsLoaded ? (
      <LinkClinicianCard
        clinicians={clinicians}
        staleLink={!!prefs.clinicianId}
        onLink={(clinicianId) => {
          onUpdatePrefs({ clinicianId });
          setViewedOverride(null);
        }}
      />
    ) : (
      <div className="px-6 py-16 text-center text-sm text-slate-600 dark:text-slate-400">Loading your plan…</div>
    );
  } else {
    const lanePlans = dayLanes ? dayLanes.lanes.map((lane) => lane.plan) : [];
    const found = selection ? findShift([plan, ...lanePlans], selection.shiftId) : null;
    const detailTarget = found ?? (fallbackId ? findShift([plan], fallbackId) : null);
    const renderDetail = (variant: "auto" | "inline") =>
      detailTarget ? (
        <ShiftDetail
          key={detailTarget.shift.id}
          variant={variant}
          // Only the wide inline card of day · date on left uses three columns.
          layout={variant === "inline" && orientation === "left" ? "columns" : "stack"}
          shift={detailTarget.shift}
          plan={detailTarget.plan}
          source={source}
          isMe={detailTarget.plan.clinicianId === viewedId}
          anchorEl={selection?.anchor ?? null}
          isMobile={isMobile}
          isDark={isDark}
          locationsById={locationsById}
          onClose={closeDetail}
          onShowInTeam={showInTeam}
        />
      ) : null;

    // With the inline card, the shift it shows is the selected one (SPEC E4
    // "preselected") in both orientations, and clicking it again keeps it.
    const selectInline: SelectShift = (shiftId, anchor) => {
      if (shiftId) selectShift(shiftId, anchor);
    };
    const viewProps: PlanViewProps = {
      plan,
      days: plan.days,
      selectedShiftId: inlineDayDetail ? detailTarget?.shift.id ?? null : found ? selection?.shiftId ?? null : null,
      onSelectShift: inlineDayDetail ? selectInline : selectShift,
      nowMin,
      isMobile,
      isDark,
      locationsById,
      sameDutyByShift: data.sameDutyByShift,
    };
    if (range === "week") {
      body = orientation === "top" ? <WeekTopView {...viewProps} /> : <WeekLeftView {...viewProps} />;
    } else if (range === "day") {
      const dayProps = {
        ...viewProps,
        lanes: dayLanes?.lanes ?? [],
        hiddenColleagueCount: dayLanes?.hiddenColleagueCount ?? 0,
        detailSlot: inlineDayDetail ? renderDetail("inline") : undefined,
        onPickDay: !isMobile ? (dateISO: string) => onAnchorDateChange(parseISODate(dateISO)) : undefined,
      };
      body = orientation === "top" ? <DayTopView {...dayProps} /> : <DayLeftView {...dayProps} />;
    } else {
      const monthProps = { ...viewProps, monthAnchor: anchorDate, weekHours: data.weekHours, onOpenDay: openDay };
      body = orientation === "top" ? <MonthCalendarView {...monthProps} /> : <MonthListView {...monthProps} />;
    }
    if (!inlineDayDetail && found) detail = renderDetail("auto");
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 sm:pb-10">
      <section
        aria-label={viewingOther && viewed ? `Plan of ${viewed.name}` : "My plan"}
        className="relative mt-4 rounded-2xl border-2 border-slate-900/80 bg-white p-[2px] text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 sm:mt-6 sm:rounded-3xl"
      >
        <div className="relative rounded-[calc(1rem-2px)] bg-white dark:bg-slate-900 sm:rounded-[calc(1.5rem-2px)]">
          <div className="relative z-20 px-4 py-3 sm:px-6 sm:py-4">{header}</div>
          {viewingOther && viewed ? (
            <ViewingBanner name={viewed.name} onBack={() => setViewedOverride(null)} />
          ) : null}
          <div
            ref={bodyRef}
            data-plan-grid=""
            role="region"
            aria-label={formatPeriodLabel(range, anchorDate)}
            tabIndex={-1}
            className="border-t border-slate-200 focus:outline-none focus-visible:rounded-none focus-visible:shadow-none dark:border-slate-700"
          >
            {body}
          </div>
          {plan ? (
            <PlanFooter
              summary={range === "month" ? undefined : footerSummary(range, data, viewed, anchorDate, plan)}
              legendItems={data.legend.items}
              hasDraft={data.legend.hasDraft}
              isDark={isDark}
            />
          ) : null}
        </div>
      </section>
      {detail}
      <Toast toast={toast} onDismiss={dismissToast} isMobile={isMobile} />
    </div>
  );
}
