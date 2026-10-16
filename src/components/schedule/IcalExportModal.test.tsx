import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import IcalExportModal from "./IcalExportModal";

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
    });
  });
});
