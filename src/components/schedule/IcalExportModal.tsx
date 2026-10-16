import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { getPillToggleClasses } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";
import type { IcalPublishStatus, PdfLayout } from "../../api/client";
import { useConfirm } from "../ui/ConfirmDialog";
import CustomNumberInput from "./CustomNumberInput";
import CustomDatePicker from "./CustomDatePicker";

type IcalExportModalProps = {
  open: boolean;
  onClose: () => void;
  clinicians: Array<{ id: string; name: string }>;
  defaultStartISO: string;
  defaultEndISO: string;
  defaultPdfStartISO: string;
  onDownloadAll: (range: { startISO?: string; endISO?: string }) => void;
  onDownloadClinician: (
    clinicianId: string,
    range: { startISO?: string; endISO?: string },
  ) => void;
  publishStatus: IcalPublishStatus | null;
  publishLoading: boolean;
  publishError: string | null;
  onPublish: () => void;
  onRotate: () => void;
  onUnpublish: () => void;
  onExportPdf: (args: {
    startISO: string;
    weeks: number;
    mode: "combined" | "individual";
    layout: PdfLayout;
  }) => void;
  /** Page layout preselected when the dialog opens (the team grid's "Times"). */
  defaultPdfLayout?: PdfLayout;
  /** The compact portrait page exists for the standard week grid only. */
  offerPdfPortrait?: boolean;
  pdfExporting: boolean;
  pdfProgress?: { current: number; total: number } | null;
  pdfError?: string | null;
  webStatus: { published: boolean; token?: string } | null;
  webLoading: boolean;
  webError: string | null;
  onWebPublish: () => void;
  onWebRotate: () => void;
  onWebUnpublish: () => void;
};

export default function IcalExportModal({
  open,
  onClose,
  clinicians,
  defaultStartISO,
  defaultEndISO,
  defaultPdfStartISO,
  onDownloadAll,
  onDownloadClinician,
  publishStatus,
  publishLoading,
  publishError,
  onPublish,
  onRotate,
  onUnpublish,
  onExportPdf,
  defaultPdfLayout = "landscape",
  offerPdfPortrait = false,
  pdfExporting,
  pdfProgress,
  pdfError,
  webStatus,
  webLoading,
  webError,
  onWebPublish,
  onWebRotate,
  onWebUnpublish,
}: IcalExportModalProps) {
  const confirm = useConfirm();
  const [startText, setStartText] = useState<string>("");
  const [endText, setEndText] = useState<string>("");
  const [tab, setTab] = useState<"pdf" | "ical" | "web">("pdf");
  const [icalTab, setIcalTab] = useState<"download" | "subscribe">("subscribe");
  const [pdfStartText, setPdfStartText] = useState<string>("");
  const [pdfWeeks, setPdfWeeks] = useState<number>(1);
  const [pdfMode, setPdfMode] = useState<"combined" | "individual">("combined");
  const [pdfLayout, setPdfLayout] = useState<PdfLayout>("landscape");
  const [copyState, setCopyState] = useState<{
    status: "idle" | "copied" | "error";
    key?: string;
  }>({ status: "idle" });

  const isoToEuropean = (dateISO: string) => {
    const [year, month, day] = dateISO.split("-");
    if (!year || !month || !day) return dateISO;
    return `${day}.${month}.${year}`;
  };

  const parseDateInput = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { iso: undefined as string | undefined, valid: true };
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return { iso: trimmed, valid: true };
    const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!dotMatch) return { iso: undefined as string | undefined, valid: false };
    const [, dayRaw, monthRaw, yearRaw] = dotMatch;
    const day = Number(dayRaw);
    const month = Number(monthRaw);
    const year = Number(yearRaw);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
      return { iso: undefined as string | undefined, valid: false };
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return { iso: undefined as string | undefined, valid: false };
    }
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return { iso: `${yyyy}-${mm}-${dd}`, valid: true };
  };

  useEffect(() => {
    if (!open) return;
    setTab("pdf");
    setIcalTab("subscribe");
    setCopyState({ status: "idle" });
    setStartText(isoToEuropean(defaultStartISO));
    setEndText(isoToEuropean(defaultEndISO));
    setPdfStartText(isoToEuropean(defaultPdfStartISO));
    setPdfWeeks(1);
    setPdfMode("combined");
    setPdfLayout(offerPdfPortrait ? defaultPdfLayout : "landscape");
  }, [defaultEndISO, defaultPdfLayout, defaultPdfStartISO, defaultStartISO, offerPdfPortrait, open]);

  const range = useMemo(() => {
    const parsedStart = parseDateInput(startText);
    const parsedEnd = parseDateInput(endText);
    const start = parsedStart.valid ? parsedStart.iso : undefined;
    const end = parsedEnd.valid ? parsedEnd.iso : undefined;
    if (start && end && start > end) {
      return { startISO: end, endISO: start };
    }
    return { startISO: start, endISO: end };
  }, [endText, startText]);

  const validation = useMemo(() => {
    const parsedStart = parseDateInput(startText);
    const parsedEnd = parseDateInput(endText);
    return {
      startValid: parsedStart.valid,
      endValid: parsedEnd.valid,
      hasError: !parsedStart.valid || !parsedEnd.valid,
    };
  }, [endText, startText]);

  const pdfValidation = useMemo(() => {
    const parsedStart = parseDateInput(pdfStartText);
    // Unlike the iCal range, an empty start is not "all dates" here: the PDF
    // export needs a concrete starting week.
    const startValid = parsedStart.valid && Boolean(parsedStart.iso);
    const weeksValid = pdfWeeks >= 1 && pdfWeeks <= 55;
    return {
      startValid,
      startISO: parsedStart.iso,
      weeksValid,
      weeks: pdfWeeks,
      hasError: !startValid || !weeksValid,
    };
  }, [pdfStartText, pdfWeeks]);

  const subscribeUrl = publishStatus?.all?.subscribeUrl ?? "";
  const clinicianLinks = publishStatus?.clinicians ?? [];
  const canPublish = !publishLoading;
  const isPublished = publishStatus?.published === true;
  const isWebPublished = webStatus?.published === true;
  const webLink =
    webStatus?.token && typeof window !== "undefined"
      ? `${window.location.origin}/public/${webStatus.token}`
      : "";

  const copyToClipboard = async (value: string, key: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState({ status: "copied", key });
      window.setTimeout(() => setCopyState({ status: "idle" }), 1200);
      return;
    } catch {
      // fall through
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      if (ok) {
        setCopyState({ status: "copied", key });
        window.setTimeout(() => setCopyState({ status: "idle" }), 1200);
      } else {
        setCopyState({ status: "error", key });
      }
    } catch {
      setCopyState({ status: "error", key });
    }
  };

  const getCopyLabel = (key: string) => {
    if (copyState.status === "copied" && copyState.key === key) return "Copied";
    if (copyState.status === "error" && copyState.key === key) return "Copy failed";
    return "Copy";
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-slate-900/30 backdrop-blur-[1px] dark:bg-slate-950/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative mx-auto mt-24 w-full max-w-2xl px-6">
        <div className="flex max-h-[80vh] flex-col rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5 dark:border-slate-800">
            <div>
              <div className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                Export
              </div>
              <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Choose a format and configure your export.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={cx(
                "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900",
                "hover:bg-slate-50 active:bg-slate-100",
                "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
              )}
            >
              Close
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
              PDF creates printable week exports. iCal can be downloaded as files or shared as
              subscription links. Web creates a read-only public view link.
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setTab("pdf")}
                className={getPillToggleClasses(tab === "pdf")}
              >
                PDF
              </button>
              <button
                type="button"
                onClick={() => setTab("ical")}
                className={getPillToggleClasses(tab === "ical")}
              >
                iCal
              </button>
              <button
                type="button"
                onClick={() => setTab("web")}
                className={getPillToggleClasses(tab === "web")}
              >
                Web
              </button>
            </div>

            {tab === "ical" ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIcalTab("subscribe")}
                  className={getPillToggleClasses(icalTab === "subscribe")}
                >
                  Subscription
                </button>
                <button
                  type="button"
                  onClick={() => setIcalTab("download")}
                  className={getPillToggleClasses(icalTab === "download")}
                >
                  Download
                </button>
              </div>
            ) : null}

            {tab === "ical" && icalTab === "download" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Time range
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setStartText(isoToEuropean(defaultStartISO));
                        setEndText(isoToEuropean(defaultEndISO));
                      }}
                      className={cx(
                        "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
                      )}
                    >
                      Current week
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStartText("");
                        setEndText("");
                      }}
                      className={cx(
                        "rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
                      )}
                    >
                      All dates
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">
                      Start (inclusive)
                    </span>
                    <CustomDatePicker
                      value={startText}
                      onChange={setStartText}
                      placeholder="DD.MM.YYYY"
                      hasError={!validation.startValid}
                    />
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">
                      End (inclusive)
                    </span>
                    <CustomDatePicker
                      value={endText}
                      onChange={setEndText}
                      placeholder="DD.MM.YYYY"
                      hasError={!validation.endValid}
                    />
                  </div>
                </div>
                {validation.hasError ? (
                  <div className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-300">
                    Invalid date format. Use DD.MM.YYYY.
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Leave Start/End empty to export everything. If Start is after End, the range
                    is automatically swapped.
                  </div>
                )}
              </div>
            ) : tab === "ical" && icalTab === "subscribe" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Subscription scope
                </div>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  This subscription feed contains only weeks marked{" "}
                  <span className="font-semibold">Published</span> in the schedule view.
                </div>
              </div>
            ) : null}

            {tab === "pdf" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  PDF export
                </div>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Choose a starting week and how many weeks to export.
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">
                      Start week (DD.MM.YYYY)
                    </span>
                    <CustomDatePicker
                      value={pdfStartText}
                      onChange={setPdfStartText}
                      placeholder="DD.MM.YYYY"
                    />
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">
                      Number of weeks
                    </span>
                    <CustomNumberInput
                      value={pdfWeeks}
                      onChange={setPdfWeeks}
                      min={1}
                      max={55}
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPdfMode("combined")}
                    className={getPillToggleClasses(pdfMode === "combined")}
                  >
                    Export as one large PDF file
                  </button>
                  <button
                    type="button"
                    onClick={() => setPdfMode("individual")}
                    className={getPillToggleClasses(pdfMode === "individual")}
                  >
                    Export PDF as individual files
                  </button>
                </div>
                {offerPdfPortrait ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Page layout">
                    <button
                      type="button"
                      aria-pressed={pdfLayout === "landscape"}
                      onClick={() => setPdfLayout("landscape")}
                      className={getPillToggleClasses(pdfLayout === "landscape")}
                    >
                      Landscape · times side by side
                    </button>
                    <button
                      type="button"
                      aria-pressed={pdfLayout === "portrait"}
                      onClick={() => setPdfLayout("portrait")}
                      className={getPillToggleClasses(pdfLayout === "portrait")}
                    >
                      Portrait · compact week
                    </button>
                  </div>
                ) : null}
                {pdfValidation.hasError ? (
                  <div className="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-300">
                    Enter a valid start date and number of weeks (1–55).
                  </div>
                ) : null}
                {pdfError ? (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200">
                    {pdfError}
                  </div>
                ) : null}
                {pdfProgress ? (
                  <div className="mt-3 text-xs font-semibold text-slate-600 dark:text-slate-300">
                    Exporting {pdfProgress.current} of {pdfProgress.total} weeks…
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!pdfValidation.startISO) return;
                      onExportPdf({
                        startISO: pdfValidation.startISO,
                        weeks: pdfValidation.weeks,
                        mode: pdfMode,
                        layout: offerPdfPortrait ? pdfLayout : "landscape",
                      });
                    }}
                    disabled={pdfValidation.hasError || pdfExporting}
                    className={cx(
                      "inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900",
                      "hover:bg-slate-50 active:bg-slate-100",
                      "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    Export PDF
                  </button>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {pdfMode === "combined"
                      ? "Download as one file."
                      : "Files download one by one."}
                  </span>
                </div>
              </div>
            ) : tab === "web" ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Links active
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isWebPublished}
                    onClick={async () => {
                      if (webLoading) return;
                      if (isWebPublished) {
                        const ok = await confirm({
                          title: "Disable Link",
                          message: "Disable this link? The public page will stop working.",
                          confirmLabel: "Disable",
                          variant: "warning",
                        });
                        if (!ok) return;
                        onWebUnpublish();
                        return;
                      }
                      onWebPublish();
                    }}
                    className={cx(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                      isWebPublished
                        ? "bg-emerald-500"
                        : "bg-slate-300 dark:bg-slate-700",
                    )}
                  >
                    <span
                      className={cx(
                        "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                        isWebPublished && "translate-x-[22px]",
                      )}
                    />
                  </button>
                </div>

                {webError ? (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200">
                    {webError}
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!isWebPublished) return;
                      const ok = await confirm({
                        title: "Refresh Link",
                        message: "Refresh the link? The old link will stop working.",
                        confirmLabel: "Refresh",
                        variant: "warning",
                      });
                      if (!ok) return;
                      onWebRotate();
                    }}
                    disabled={!isWebPublished || webLoading}
                    className={cx(
                      "inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900",
                      "hover:bg-slate-50 active:bg-slate-100",
                      "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    Refresh link
                  </button>
                </div>

                {isWebPublished && webLink ? (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-slate-500 dark:text-slate-300">
                      Public view link
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={webLink}
                        className={cx(
                          "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900",
                          "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(webLink, "web")}
                        className={cx(
                          "shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900",
                          "hover:bg-slate-50 active:bg-slate-100",
                          "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                        )}
                      >
                        {getCopyLabel("web")}
                      </button>
                    </div>
                    <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Anyone with this link can view the schedule (read-only).
                    </div>
                  </div>
                ) : null}
              </div>
            ) : tab === "ical" && icalTab === "download" ? (
              <>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    iCal download
                  </div>
                  <button
                    type="button"
                    onClick={() => onDownloadAll(range)}
                    disabled={validation.hasError}
                    className={cx(
                      "inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900",
                      "hover:bg-slate-50 active:bg-slate-100",
                      "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    All people (one file)
                  </button>
                </div>

                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
                  <div className="bg-white px-4 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-900 dark:text-slate-300">
                    Individual files
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">
                    {clinicians.map((clinician) => (
                      <div
                        key={clinician.id}
                        className="flex items-center justify-between gap-3 bg-white px-4 py-3 dark:bg-slate-900"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {clinician.name}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onDownloadClinician(clinician.id, range)}
                          disabled={validation.hasError}
                          className={cx(
                            "inline-flex items-center rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900",
                            "hover:bg-slate-50 active:bg-slate-100",
                            "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                          )}
                        >
                          Download
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                  Tip: Import the downloaded <span className="font-semibold">.ics</span>{" "}
                  file into your calendar app (Google Calendar, Apple Calendar, Outlook).
                </div>
              </>
            ) : tab === "ical" && icalTab === "subscribe" ? (
              <>
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Links active
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isPublished}
                      onClick={async () => {
                        if (publishLoading) return;
                        if (isPublished) {
                          const ok = await confirm({
                            title: "Disable Links",
                            message: "Disable these links? Existing subscription links will stop working.",
                            confirmLabel: "Disable",
                            variant: "warning",
                          });
                          if (!ok) return;
                          onUnpublish();
                          return;
                        }
                        onPublish();
                      }}
                      className={cx(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                        isPublished
                          ? "bg-emerald-500"
                          : "bg-slate-300 dark:bg-slate-700",
                      )}
                    >
                      <span
                        className={cx(
                          "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
                          isPublished && "translate-x-[22px]",
                        )}
                      />
                    </button>
                  </div>

                  {publishError ? (
                    <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/30 dark:text-rose-200">
                      {publishError}
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!isPublished) return;
                        const ok = await confirm({
                          title: "Refresh Links",
                          message: "Refresh the links? Old links will stop working.",
                          confirmLabel: "Refresh",
                          variant: "warning",
                        });
                        if (!ok) return;
                        onRotate();
                      }}
                      disabled={!isPublished || publishLoading}
                      className={cx(
                        "inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900",
                        "hover:bg-slate-50 active:bg-slate-100",
                        "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                    >
                      Refresh links
                    </button>
                  </div>

                  {isPublished ? (
                    <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
                      <div className="bg-white px-4 py-2 text-xs font-semibold text-slate-500 dark:bg-slate-900 dark:text-slate-300">
                        Subscription links
                      </div>
                      <div className="divide-y divide-slate-200 dark:divide-slate-800">
                        {[{ clinicianId: "all", clinicianName: "All people", subscribeUrl }, ...clinicianLinks]
                          .filter((item) => item.subscribeUrl)
                          .map((clinician) => {
                            const key = `clinician-${clinician.clinicianId}`;
                            return (
                              <div
                                key={clinician.clinicianId}
                                className="bg-white px-4 py-3 dark:bg-slate-900"
                              >
                                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                                  {clinician.clinicianName}
                                </div>
                                <div className="mt-2 flex gap-2">
                                  <input
                                    type="text"
                                    readOnly
                                    value={clinician.subscribeUrl}
                                    className={cx(
                                      "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900",
                                      "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
                                    )}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(clinician.subscribeUrl, key)}
                                    className={cx(
                                      "shrink-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900",
                                      "hover:bg-slate-50 active:bg-slate-100",
                                      "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700",
                                    )}
                                  >
                                    {getCopyLabel(key)}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                      <div className="bg-white px-4 py-2 text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                        Anyone with these links can subscribe (read-only). Keep them private.
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
