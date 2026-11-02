import { describe, expect, it } from "vitest";
import { matchesSearch, normalizeForSearch } from "./textSearch";

const roster = [
  "Müller, Jörg; Dr.",
  "Zoë O'Brien-Łukasiewicz",
  "Ünal Çelik",
  "Björn Ødegård",
  "Anaïs Lefèvre",
  "Émile Zürcher",
  "Weiß Straße",
  "Aylin Yılmaz",
  "Æsa Œhler",
  "Đorđe Đukić",
];
const find = (query: string) => roster.filter((name) => matchesSearch(name, query));

describe("normalizeForSearch", () => {
  it("folds case, accents and letters without a decomposition", () => {
    expect(normalizeForSearch("Zoë O'Brien-Łukasiewicz")).toBe("zoe obrien-lukasiewicz");
    expect(normalizeForSearch("D’Angelo")).toBe("dangelo");
    expect(normalizeForSearch("  Weiß   Straße ")).toBe("weiss strasse");
    expect(normalizeForSearch("Yılmaz İnce")).toBe("yilmaz ince");
    expect(normalizeForSearch("Ødegård Æsa Œhler Đukić")).toBe("odegard aesa oehler dukic");
  });

  it("treats decomposed input like composed input", () => {
    expect(normalizeForSearch("Müller")).toBe(normalizeForSearch("Müller"));
  });
});

describe("matchesSearch", () => {
  it.each([
    ["Jorg", "Müller, Jörg; Dr."],
    ["joerg", "Müller, Jörg; Dr."],
    ["muller", "Müller, Jörg; Dr."],
    ["mueller", "Müller, Jörg; Dr."],
    ["MÜLL", "Müller, Jörg; Dr."],
    ["zoe", "Zoë O'Brien-Łukasiewicz"],
    ["lukasiewicz", "Zoë O'Brien-Łukasiewicz"],
    ["celik", "Ünal Çelik"],
    ["unal", "Ünal Çelik"],
    ["odegard", "Björn Ødegård"],
    ["bjoern", "Björn Ødegård"],
    ["Lefevre", "Anaïs Lefèvre"],
    ["anais", "Anaïs Lefèvre"],
    ["zuercher", "Émile Zürcher"],
    ["strasse", "Weiß Straße"],
    ["yilmaz", "Aylin Yılmaz"],
    ["aesa", "Æsa Œhler"],
    ["oehler", "Æsa Œhler"],
    ["dukic", "Đorđe Đukić"],
    ["obrien", "Zoë O'Brien-Łukasiewicz"],
    // Words in any order: the given-first name the app shows (review).
    ["jörg müller", "Müller, Jörg; Dr."],
    ["jorg muller", "Müller, Jörg; Dr."],
    ["muller jorg", "Müller, Jörg; Dr."],
    ["Müller, J", "Müller, Jörg; Dr."],
    ["zoe lukas", "Zoë O'Brien-Łukasiewicz"],
  ])("'%s' finds '%s'", (query, name) => {
    expect(find(query)).toEqual([name]);
  });

  it("matches a transliterated name with an umlaut query", () => {
    expect(matchesSearch("Hans Mueller", "Müller")).toBe(true);
    expect(matchesSearch("Hans Mueller", "muell")).toBe(true);
  });

  it("matches everything for an empty or blank query and nothing unrelated", () => {
    expect(find("")).toHaveLength(roster.length);
    expect(find("   ")).toHaveLength(roster.length);
    expect(find("xyz")).toEqual([]);
    expect(find("jörg xyz")).toEqual([]);
  });
});
