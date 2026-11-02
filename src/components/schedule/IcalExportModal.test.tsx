import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import IcalExportModal, { formatPdfProgress } from "./IcalExportModal";

type Props = ComponentProps<typeof IcalExportModal>;

const renderModal = (overrides: Partial<Props> = {}) => {
  const props: Props = {
    open: true,
    onClose: vi.fn(),
    clinicians: [],
    defaultStartISO: "2026-03-02",
    defaultEndISO: "2026-03-08",
    defaultPdfStartISO: "2026-03-02",
    onDownloadAll: vi.fn(),
    onDownloadClinician: vi.fn(),
    timeZone: "Europe/Berlin",
    publishStatus: null,
    publishLoading: false,
    publishError: null,
    onPublish: vi.fn(),
    onRotate: vi.fn(),
    onUnpublish: vi.fn(),
    onExportPdf: vi.fn(),
    pdfExporting: false,
    webStatus: null,
    webLoading: false,
    webError: null,
    onWebPublish: vi.fn(),
    onWebRotate: vi.fn(),
    onWebUnpublish: vi.fn(),
    ...overrides,
  };
  render(
    <ConfirmDialogProvider>
      <IcalExportModal {...props} />
    </ConfirmDialogProvider>,
  );
  return props;
};

const exportPdfButton = () =>
  screen.getByRole("button", { name: "Export PDF" }) as HTMLButtonElement;

describe("IcalExportModal PDF export", () => {
  it("disables the export and explains why when no start date is set", () => {
    const props = renderModal({ defaultPdfStartISO: "" });
    expect(exportPdfButton().disabled).toBe(true);
    expect(screen.getByText(/Enter a valid start date/)).toBeInTheDocument();
    fireEvent.click(exportPdfButton());
    expect(props.onExportPdf).not.toHaveBeenCalled();
  });

  it("exports one combined file from the given start week by default", () => {
    const props = renderModal();
    expect(exportPdfButton().disabled).toBe(false);
    fireEvent.click(exportPdfButton());
    expect(props.onExportPdf).toHaveBeenCalledWith({
      startISO: "2026-03-02",
      weeks: 1,
      mode: "combined",
      layout: "landscape",
    });
    // Without the portrait option (monthly sheet) there is no layout choice.
    expect(screen.queryByRole("group", { name: "Page layout" })).toBeNull();
  });

  it("preselects the compact portrait page and lets the user switch to landscape", () => {
    const props = renderModal({ offerPdfPortrait: true, defaultPdfLayout: "portrait" });
    const portrait = screen.getByRole("button", { name: "Portrait · compact week" });
    expect(portrait.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(exportPdfButton());
    expect(props.onExportPdf).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "portrait" }));
    fireEvent.click(screen.getByRole("button", { name: "Landscape · times side by side" }));
    fireEvent.click(exportPdfButton());
    expect(props.onExportPdf).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "landscape" }));
  });

  it("shows no fake counter for one combined file, and k of N for individual files", () => {
    renderModal({ pdfExporting: true, pdfProgress: { mode: "combined", total: 3 } });
    expect(screen.getByText("Creating PDF for 3 weeks…")).toBeInTheDocument();
    expect(screen.queryByText(/0 of 3/)).toBeNull();
    expect(formatPdfProgress({ mode: "combined", total: 1 })).toBe("Creating PDF for 1 week…");
    expect(formatPdfProgress({ mode: "individual", current: 2, total: 5 })).toBe(
      "Exporting 2 of 5 weeks…",
    );
    expect(formatPdfProgress({ mode: "individual", current: 1, total: 1 })).toBe("Exporting 1 of 1 week…");
  });

  it("never sends portrait when the option is not offered", () => {
    const props = renderModal({ offerPdfPortrait: false, defaultPdfLayout: "portrait" });
    fireEvent.click(exportPdfButton());
    expect(props.onExportPdf).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "landscape" }));
  });
});

describe("IcalExportModal iCal download", () => {
  it("swaps a start date after the end date", () => {
    const props = renderModal({ defaultStartISO: "2026-03-08", defaultEndISO: "2026-03-02" });
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "All people (one file)" }));
    expect(props.onDownloadAll).toHaveBeenCalledWith({
      startISO: "2026-03-02",
      endISO: "2026-03-08",
      includeUnpublished: false,
    });
  });

  it("exports published weeks only unless unpublished weeks are included", () => {
    const props = renderModal({ clinicians: [{ id: "c1", name: "Dr. A" }] });
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const checkbox = screen.getByRole("checkbox", { name: "Include unpublished weeks" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText(/Only weeks marked Published/)).toBeInTheDocument();
    expect(screen.getByText(/Europe\/Berlin, from the\s+holiday country/)).toBeInTheDocument();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "All people (one file)" }));
    expect(props.onDownloadAll).toHaveBeenLastCalledWith(expect.objectContaining({ includeUnpublished: true }));
    fireEvent.click(screen.getByRole("button", { name: "Download iCal file for Dr. A" }));
    expect(props.onDownloadClinician).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({ includeUnpublished: true }),
    );
  });

  it("shows why nothing was downloaded instead of saving an empty file (re-QA)", () => {
    const notice = "Nothing was downloaded: the shifts in this range are in weeks that are not published.";
    renderModal({ clinicians: [{ id: "c1", name: "Dr. A" }], onDownloadAll: vi.fn(() => notice) });
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "All people (one file)" }));
    expect(screen.getByRole("status")).toHaveTextContent(notice);
    // Ticking the checkbox clears it.
    fireEvent.click(screen.getByRole("checkbox", { name: "Include unpublished weeks" }));
    expect(screen.queryByText(notice)).toBeNull();
  });
});

describe("IcalExportModal iCal subscription", () => {
  it("names the plan's time zone of the event times", () => {
    renderModal({ timeZone: "Europe/London" });
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    expect(screen.getByText(/Europe\/London, from the\s+holiday country/)).toBeInTheDocument();
    expect(screen.queryByText(/all-day/i)).toBeNull();
  });
});

describe("IcalExportModal as a dialog (re-QA)", () => {
  it("is a labelled modal dialog that takes focus and closes on Escape", () => {
    const props = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Export" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("leaves Escape to the export overlay while a PDF is being created", () => {
    const props = renderModal({ pdfExporting: true, pdfProgress: { mode: "combined", total: 2 } });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Export" }), { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("names every person's download button", () => {
    renderModal({ clinicians: [{ id: "c1", name: "Dr. A" }, { id: "c2", name: "Dr. B" }] });
    fireEvent.click(screen.getByRole("button", { name: "iCal" }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("button", { name: "Download iCal file for Dr. A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download iCal file for Dr. B" })).toBeInTheDocument();
  });
});

describe("IcalExportModal inner popups (re-QA)", () => {
  it("Escape in the start-week picker closes only the picker", () => {
    const props = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Export" });
    const trigger = within(dialog).getByRole("button", { name: "02.03.2026" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Previous month" })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Previous month" })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    // A second Escape (picker closed) closes the dialog.
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps Export PDF focusable while exporting, so focus can come back to it", () => {
    renderModal({ pdfExporting: true, pdfProgress: { mode: "combined", total: 2 } });
    const button = screen.getByRole("button", { name: "Export PDF" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });
});
