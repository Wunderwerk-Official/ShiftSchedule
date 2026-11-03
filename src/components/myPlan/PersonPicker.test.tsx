import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Clinician } from "../../api/client";
import PersonPicker, { changeLinkLabel } from "./PersonPicker";

const person = (id: string, name: string): Clinician => ({
  id,
  name,
  qualifiedClassIds: [],
  preferredClassIds: [],
  vacations: [],
});

const clinicians = [
  person("jm", "Müller, Jörg; Dr."),
  person("zo", "Zoë O'Brien-Łukasiewicz"),
  person("uc", "Ünal Çelik"),
  person("bo", "Björn Ødegård"),
  person("al", "Anaïs Lefèvre"),
  person("jw", "Jonas Weber"),
];

const openPicker = () => {
  render(<PersonPicker clinicians={clinicians} viewedId="jw" myId="jw" onChange={vi.fn()} onChangeLink={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open the plan of another person" }));
  return screen.getByRole("dialog", { name: "Choose person" });
};

describe("PersonPicker", () => {
  it("finds people without typing their accents", () => {
    const picker = openPicker();
    const search = within(picker).getByPlaceholderText("Search person");
    const found = (query: string) => {
      fireEvent.change(search, { target: { value: query } });
      return within(within(picker).getByRole("list", { name: "People" }))
        .queryAllByRole("button")
        .map((button) => button.textContent ?? "");
    };
    // Also by the name the app shows ("Jörg Müller"), words in any order.
    for (const query of ["muller", "mueller", "Jorg", "joerg", "jörg müller", "jorg muller"]) {
      expect(found(query), query).toEqual([expect.stringContaining("Müller, Jörg; Dr.")]);
    }
    expect(found("zoe")).toEqual([expect.stringContaining("Zoë")]);
    expect(found("lukasiewicz")).toEqual([expect.stringContaining("Łukasiewicz")]);
    expect(found("celik")).toEqual([expect.stringContaining("Çelik")]);
    expect(found("odegard")).toEqual([expect.stringContaining("Ødegård")]);
    expect(found("Lefevre")).toEqual([expect.stringContaining("Lefèvre")]);
    expect(found("obrien")).toEqual([expect.stringContaining("O'Brien")]);
    expect(found("xyz")).toEqual([]);
  });

  it("shows the initials of given and family name, also for 'Last, First'", () => {
    const picker = openPicker();
    fireEvent.change(within(picker).getByPlaceholderText("Search person"), { target: { value: "jorg" } });
    expect(within(picker).getByRole("button", { name: /Müller, Jörg; Dr\./ })).toHaveTextContent(/^JM/);
  });

  it("names the linked person without titles in the footer", () => {
    expect(changeLinkLabel("Müller, Jörg; Dr.")).toBe("Not Jörg Müller? Change who you are");
    // A note that tells two people apart stays (review: "Anna Schmidt (OA)" / "(AA)").
    expect(changeLinkLabel("Anna Schmidt (OA)")).toBe("Not Anna Schmidt (OA)? Change who you are");
    expect(changeLinkLabel(undefined)).toBe("Not you? Change who you are");
  });
});
