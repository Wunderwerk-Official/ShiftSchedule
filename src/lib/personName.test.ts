import { describe, expect, it } from "vitest";
import {
  buildNameLabels,
  displayName,
  givenNameOf,
  initialsOf,
  nameLabelsOf,
  NAME_LABEL_LEVELS,
  parsePersonName,
  surnameSortKey,
} from "./personName";
import { normalizeForSearch } from "./textSearch";

const parts = (name: string) => {
  const { given, family, familyCore, titles } = parsePersonName(name);
  return { given, family, familyCore, titles };
};

describe("parsePersonName", () => {
  it.each([
    ["Anna Schmidt", ["Anna"], "Schmidt", []],
    ["Müller, Jörg; Dr.", ["Jörg"], "Müller", ["Dr."]],
    ["Müller, Jörg, Dr.", ["Jörg"], "Müller", ["Dr."]],
    ["Müller-Lüdenscheidt, Dr. Hans", ["Hans"], "Müller-Lüdenscheidt", ["Dr."]],
    ["Dr. med. Anna Schmidt", ["Anna"], "Schmidt", ["Dr.", "med."]],
    ["Dr. med. dent. Anna Schmidt", ["Anna"], "Schmidt", ["Dr.", "med.", "dent."]],
    ["Dr. rer. nat. Anna Schmidt", ["Anna"], "Schmidt", ["Dr.", "rer.", "nat."]],
    ["Dr.med. Anna Schmidt", ["Anna"], "Schmidt", ["Dr.med."]],
    ["Prof. Dr. Hans-Joachim Oberstein-Lindenberg", ["Hans-Joachim"], "Oberstein-Lindenberg", ["Prof.", "Dr."]],
    ["PD Dr. Lena Hoffmann", ["Lena"], "Hoffmann", ["PD", "Dr."]],
    ["Priv.-Doz. Dr. med. Lena Hoffmann", ["Lena"], "Hoffmann", ["Priv.-Doz.", "Dr.", "med."]],
    ["Dipl.-Med. Lena Hoffmann", ["Lena"], "Hoffmann", ["Dipl.-Med."]],
    ["Anna Schmidt, MD", ["Anna"], "Schmidt", ["MD"]],
    ["Anna Schmidt PhD", ["Anna"], "Schmidt", ["PhD"]],
    ["Anna Maria Schmidt", ["Anna", "Maria"], "Schmidt", []],
    ["Dr. Nat King", ["Nat"], "King", ["Dr."]],
    ["Hans \"Hansi\" Müller (geb. Meier)", ["Hans"], "Müller", []],
    // Austrian, Czech, Italian and Spanish titles (review: "Dr.in M.", "em. Hans Meier").
    ["Dr.in Eva Maier", ["Eva"], "Maier", ["Dr.in"]],
    ["Mag. pharm. Eva Maier", ["Eva"], "Maier", ["Mag.", "pharm."]],
    ["Mag.a Eva Maier", ["Eva"], "Maier", ["Mag.a"]],
    ["Univ.-Doz. Dr. Hans Meier", ["Hans"], "Meier", ["Univ.-Doz.", "Dr."]],
    ["Prof. em. Dr. Hans Meier", ["Hans"], "Meier", ["Prof.", "em.", "Dr."]],
    ["doc. MUDr. Jan Novák", ["Jan"], "Novák", ["doc.", "MUDr."]],
    ["Ing. Jan Novák", ["Jan"], "Novák", ["Ing."]],
    ["Ing Chen", ["Ing"], "Chen", []],
    ["Dott.ssa Giulia Rossi", ["Giulia"], "Rossi", ["Dott.ssa"]],
    ["Dra. Carmen López", ["Carmen"], "López", ["Dra."]],
    // Degrees after a comma are not "Last, First" (review: "MPH A.").
    ["Anna Schmidt, MPH", ["Anna"], "Schmidt", ["MPH"]],
    ["Jörg Müller, FRCR", ["Jörg"], "Müller", ["FRCR"]],
    ["Anna Schmidt, EDiR", ["Anna"], "Schmidt", ["EDiR"]],
    ["Jörg Müller, Dr. med., MHBA", ["Jörg"], "Müller", ["Dr.", "med.", "MHBA"]],
    ["Lisa Wolf, M.A.", ["Lisa"], "Wolf", ["M.A."]],
    ["Paul Kern, B.Sc.", ["Paul"], "Kern", ["B.Sc."]],
    ["Jean DUPONT, MPH", ["Jean"], "DUPONT", ["MPH"]],
    // … while a name before the comma that is one word, or in capitals, is "Last, First".
    ["SCHMIDT, ANNA", ["ANNA"], "SCHMIDT", []],
    ["SCHMIDT MÜLLER, ANNA", ["ANNA"], "SCHMIDT MÜLLER", []],
    ["VAN DER BERG, JAN", ["JAN"], "VAN DER BERG", []],
    ["van Berg, J.", ["J."], "van Berg", []],
    ["García López, María José", ["María", "José"], "García López", []],
  ])("%s", (name, given, family, titles) => {
    expect(parts(name)).toMatchObject({ given, family, titles });
  });

  it("keeps particles and noble titles with the family name", () => {
    expect(parts("Ludwig van Beethoven")).toMatchObject({ given: ["Ludwig"], family: "van Beethoven", familyCore: "Beethoven" });
    expect(parts("Ursula von der Leyen")).toMatchObject({ family: "von der Leyen", familyCore: "Leyen" });
    expect(parts("van Beethoven, Ludwig")).toMatchObject({ given: ["Ludwig"], family: "van Beethoven", familyCore: "Beethoven" });
    expect(parts("Goethe, Johann Wolfgang von")).toMatchObject({
      given: ["Johann", "Wolfgang"],
      family: "von Goethe",
      familyCore: "Goethe",
    });
    expect(parts("Maximiliane-Alexandra Freifrau von Hohenzollern-Sigmaringen")).toMatchObject({
      given: ["Maximiliane-Alexandra"],
      family: "Freifrau von Hohenzollern-Sigmaringen",
      familyCore: "Hohenzollern-Sigmaringen",
    });
    expect(
      parts("Prof. Dr. med. Maximilian-Alexander von und zu Hohenzollern-Sigmaringen-Wittelsbach-Lothringen"),
    ).toMatchObject({
      given: ["Maximilian-Alexander"],
      familyCore: "Hohenzollern-Sigmaringen-Wittelsbach-Lothringen",
    });
  });

  it("reads one-word names and names without letters", () => {
    expect(parts("Jonas")).toMatchObject({ given: ["Jonas"], family: "", familyCore: "" });
    expect(parts("Dr.")).toMatchObject({ given: ["Dr."], family: "", titles: [] });
    expect(parts("Back\\Slash \"Quote\"")).toMatchObject({ given: ["Back\\Slash"], family: "" });
  });
});

describe("name helpers", () => {
  it("drops titles and puts given names first", () => {
    expect(displayName("Dr. Lena Hoffmann")).toBe("Lena Hoffmann");
    expect(displayName("Müller, Jörg; Dr.")).toBe("Jörg Müller");
    expect(displayName("van Beethoven, Ludwig")).toBe("Ludwig van Beethoven");
    expect(displayName("Anna Schmidt, MPH")).toBe("Anna Schmidt");
    expect(displayName("Prof. em. Dr. Hans Meier")).toBe("Hans Meier");
    expect(displayName("Dr.")).toBe("Dr.");
  });

  it("keeps nicknames and notes in the full name (review: two lanes 'Anna Schmidt')", () => {
    expect(displayName("Anna Schmidt (OA)")).toBe("Anna Schmidt (OA)");
    expect(displayName("Schmidt, Anna (AA); Dr.")).toBe("Anna Schmidt (AA)");
    expect(displayName("Hans \"Hansi\" Müller (geb. Meier)")).toBe("Hans \"Hansi\" Müller (geb. Meier)");
    expect(displayName("Müller, Hans „Hansi“")).toBe("Hans „Hansi“ Müller");
    expect(displayName("\"Quote\"")).toBe("\"Quote\"");
  });

  it("finds the first given name", () => {
    expect(givenNameOf("Müller, Jörg; Dr.")).toBe("Jörg");
    expect(givenNameOf("Kruppert, Hermann")).toBe("Hermann");
    expect(givenNameOf("Prof. Dr. Hans-Joachim Oberstein-Lindenberg")).toBe("Hans-Joachim");
  });

  it("builds initials from the given and the main family name", () => {
    expect(initialsOf("Müller, Jörg; Dr.")).toBe("JM");
    expect(initialsOf("Alexandre C.")).toBe("AC");
    expect(initialsOf("Ludwig van Beethoven")).toBe("LB");
    expect(initialsOf("Zoë O'Brien-Łukasiewicz")).toBe("ZO");
    expect(initialsOf("Jonas")).toBe("J");
    expect(initialsOf("  ")).toBe("?");
  });

  it("sorts by the main family name", () => {
    expect(surnameSortKey("Müller, Jörg; Dr.")).toBe("Müller");
    expect(surnameSortKey("Ludwig van Beethoven")).toBe("Beethoven");
    expect(surnameSortKey("Jonas")).toBe("Jonas");
  });
});

describe("nameLabelsOf (one person)", () => {
  it("shortens step by step: First L., F. Last, F. L., FL", () => {
    expect(nameLabelsOf("Sophie Weber").levels).toEqual(["Sophie Weber", "Sophie W.", "S. Weber", "S. W.", "SW"]);
    expect(nameLabelsOf("Sophie Weber").surname).toBe("Weber");
  });

  it("reads 'Last, First' and titled names (QA: 'Müller, D.', 'M. Dr.', 'Prof. O.', 'Dr. S.')", () => {
    expect(nameLabelsOf("Müller, Jörg; Dr.").levels).toEqual(["Müller, Jörg; Dr.", "Jörg M.", "J. Müller", "J. M.", "JM"]);
    expect(nameLabelsOf("Prof. Dr. Hans-Joachim Oberstein-Lindenberg").levels[1]).toBe("Hans-Joachim O.");
    expect(nameLabelsOf("Dr. Armand Smit").levels[1]).toBe("Armand S.");
    expect(nameLabelsOf("Ludwig van Beethoven").levels.slice(1)).toEqual([
      "Ludwig B.",
      "L. van Beethoven",
      "L. B.",
      "LB",
    ]);
    expect(
      nameLabelsOf("Prof. Dr. med. Maximilian-Alexander von und zu Hohenzollern-Sigmaringen-Wittelsbach-Lothringen")
        .levels[1],
    ).toBe("Maximilian-Alexander H.");
  });

  it("leaves noble titles out of the short forms, not out of the full name", () => {
    const labels = nameLabelsOf("Maximiliane-Alexandra Freifrau von Hohenzollern-Sigmaringen");
    expect(labels.levels.slice(1)).toEqual([
      "Maximiliane-Alexandra H.",
      "M. von Hohenzollern-Sigmaringen",
      "M. H.",
      "MH",
    ]);
    expect(labels.surname).toBe("von Hohenzollern-Sigmaringen");
    expect(displayName("Maximiliane-Alexandra Freifrau von Hohenzollern-Sigmaringen")).toBe(
      "Maximiliane-Alexandra Freifrau von Hohenzollern-Sigmaringen",
    );
  });

  it("gives the clinic sheet the family name, never a title or a first name", () => {
    expect(nameLabelsOf("Müller, Jörg; Dr.").surname).toBe("Müller");
    expect(nameLabelsOf("Schulz, Andrea").surname).toBe("Schulz");
    expect(nameLabelsOf("Dr. med. Anna Schmidt").surname).toBe("Schmidt");
    expect(nameLabelsOf("Ånström-Ñúñez, Zoë").surname).toBe("Ånström-Ñúñez");
    // A family name that is only an initial needs the given name.
    expect(nameLabelsOf("Marion P.").surname).toBe("Marion P.");
    expect(nameLabelsOf("Jonas").surname).toBe("Jonas");
  });

  it("shortens the review's titled names to the name", () => {
    expect(nameLabelsOf("Dr.in Eva Maier").levels.slice(1)).toEqual(["Eva M.", "E. Maier", "E. M.", "EM"]);
    expect(nameLabelsOf("Anna Schmidt, MPH").levels.slice(1)).toEqual(["Anna S.", "A. Schmidt", "A. S.", "AS"]);
    expect(nameLabelsOf("Anna Schmidt, MPH").surname).toBe("Schmidt");
    expect(initialsOf("MUDr. Jan Novák")).toBe("JN");
    expect(givenNameOf("Prof. em. Dr. Hans Meier")).toBe("Hans");
  });

  it("never shortens a word to something as long as the word", () => {
    expect(nameLabelsOf("Ida Ek").levels.slice(1)).toEqual(["Ida Ek", "I. Ek", "I. Ek", "IE"]);
  });
});

describe("buildNameLabels (team-wide)", () => {
  const team = (...names: string[]) => names.map((name, index) => ({ id: `c${index}`, name }));
  const labelsOf = (names: string[]) => {
    const map = buildNameLabels(team(...names));
    return names.map((_, index) => map.get(`c${index}`)!);
  };

  it("tells apart people with the same short name at every level (QA: 'Mehmet Y.', 'M. Y.')", () => {
    const [yildirim, yilmaz] = labelsOf(["Mehmet Yildirim", "Mehmet Yılmaz"]);
    // Dotless ı is not i: the labels go on until they differ in more than a dot.
    expect(yildirim.levels).toEqual(["Mehmet Yildirim", "Mehmet Yild.", "M. Yildirim", "M. Yild.", "M. Yild."]);
    expect(yilmaz.levels).toEqual(["Mehmet Yılmaz", "Mehmet Yılm.", "M. Yılmaz", "M. Yılm.", "M. Yılm."]);
    const [wagner, weber] = labelsOf(["Sophie Wagner", "Sophie Weber"]);
    expect(wagner.levels.slice(1)).toEqual(["Sophie Wa.", "S. Wagner", "S. Wa.", "S. Wa."]);
    expect(weber.levels.slice(1)).toEqual(["Sophie We.", "S. Weber", "S. We.", "S. We."]);
  });

  it("escalates with given-name letters once the family names agree", () => {
    const [stefan, sophie] = labelsOf(["Stefan Weber", "Sophie Weber"]);
    expect(stefan.levels.slice(1)).toEqual(["Stefan W.", "St. Weber", "St. W.", "St. W."]);
    expect(sophie.levels.slice(1)).toEqual(["Sophie W.", "So. Weber", "So. W.", "So. W."]);
  });

  it("never picks a label that could stand for another person", () => {
    // "St. W." would fit Stefan Wagner too; "Anna Schmid." would fit Anna Schmidt.
    const [weber, sophie, wagner] = labelsOf(["Stefan Weber", "Sophie Weber", "Stefan Wagner"]);
    expect(weber.levels[3]).toBe("St. We.");
    expect(sophie.levels[3]).toBe("So. W.");
    expect(wagner.levels[3]).toBe("S. Wa.");
    const [schmidt, schmidtke] = labelsOf(["Anna Schmidt", "Anna Schmidtke"]);
    expect(schmidt.levels[1]).toBe("Anna Schmidt");
    expect(schmidtke.levels[1]).toBe("Anna Schmidtke");
  });

  it("keeps a title or degree when the name without it reads as another person (re-QA)", () => {
    // Short labels drop notes in parentheses, so a bare "Anna Schmidt" would
    // stand for "Anna Schmidt (OA)" too.
    for (const titled of ["Dr. Anna Schmidt", "Anna Schmidt, MPH"]) {
      const [withTitle, withNote] = labelsOf([titled, "Anna Schmidt (OA)"]);
      expect(new Set(withTitle.levels.slice(1))).toEqual(new Set([titled]));
      expect(withTitle.surname).toBe(titled);
      expect(new Set(withNote.levels.slice(1))).toEqual(new Set(["Anna Schmidt (OA)"]));
    }
    const [prof] = labelsOf(["Prof. Dr. Jan Weber", "Jan Weber (AA)"]);
    expect(prof.levels[4]).toBe("Prof. Dr. Jan Weber");
    // Identical names still keep the full name.
    const [first, second] = labelsOf(["Anna Schmidt", "Anna Schmidt"]);
    expect(first.levels[4]).toBe("Anna Schmidt");
    expect(second.levels[4]).toBe("Anna Schmidt");
  });

  it("only lengthens the labels that collide", () => {
    const [anna, andreas, andrea, claire] = labelsOf(["Anna Schmidt", "Andreas Schulz", "Schulz, Andrea", "Claire Huber"]);
    expect(anna.levels[3]).toBe("A. Schm.");
    // "Andre." would fit Andrea as well, so both need their whole given name.
    expect(andreas.levels[3]).toBe("Andreas S.");
    expect(andrea.levels[3]).toBe("Andrea S.");
    expect(claire.levels.slice(1)).toEqual(["Claire H.", "C. Huber", "C. H.", "CH"]);
  });

  it("keeps identical full names full, and names that differ only in a title full", () => {
    const [first, second] = labelsOf(["Anna Schmidt", "Anna Schmidt"]);
    expect(first.levels).toEqual(Array(NAME_LABEL_LEVELS).fill("Anna Schmidt"));
    expect(second.levels).toEqual(first.levels);
    const [titled, plain] = labelsOf(["Müller, Jörg; Dr.", "Müller, Jörg"]);
    expect(titled.levels[1]).toBe("Müller, Jörg; Dr.");
    expect(plain.levels[1]).toBe("Müller, Jörg");
  });

  it("adds given-name letters to a surname two people share on the clinic sheet", () => {
    const [thomas, jorg, tobias] = labelsOf(["Thomas Müller", "Müller, Jörg", "Tobias Meier"]);
    expect(thomas.surname).toBe("T. Müller");
    expect(jorg.surname).toBe("J. Müller");
    expect(tobias.surname).toBe("Meier");
  });

  it("gives every person of a large team a label of their own at every level", () => {
    const names = [
      "Anna Schmidt", "Andreas Schulz", "Claire Hoffmann", "Claire Huber", "Thomas Müller", "Tobias Meier",
      "Dr. med. Katharina Schmidt-Rottluff", "Prof. Dr. Hans-Joachim Oberstein-Lindenberg", "Müller, Jörg",
      "Schulz, Andrea", "Lena Becker", "Lea Bauer", "Jan Kowalski", "Jana Kowalczyk", "Mehmet Yılmaz",
      "Mehmet Yildirim", "Sophie Wagner", "Sophie Weber", "Maximilian Hohenzollern-Sigmaringen", "Ole Nielsen",
      "Ida Ek", "Li Wei", "Zoë Ångström", "Björn Ækerlund", "Marion P.", "Marion Peters", "Max", "Mia",
    ];
    const labels = labelsOf(names);
    for (let level = 1; level < NAME_LABEL_LEVELS; level += 1) {
      const keys = labels.map((entry) => normalizeForSearch(entry.levels[level]));
      expect(new Set(keys).size, `level ${level}: ${keys.join(", ")}`).toBe(names.length);
    }
    expect(new Set(labels.map((entry) => entry.surname)).size).toBe(names.length);
  });

  it("counts the characters of \"First L.\" a cut must keep to stay one person's", () => {
    const [wagner, weber, sarah] = labelsOf(["Sophie Wagner", "Sophie Weber", "Sarah Neumann"]);
    // "Sophie W…" could be either Sophie; "Sa…" is only Sarah.
    expect(wagner.distinctLength).toBe(Array.from("Sophie Wa").length);
    expect(weber.distinctLength).toBe(Array.from("Sophie We").length);
    expect(sarah.distinctLength).toBe(2);
    const [yildirim, yilmaz] = labelsOf(["Mehmet Yildirim", "Mehmet Yılmaz"]);
    expect(yildirim.distinctLength).toBe(Array.from("Mehmet Yild").length);
    expect(yilmaz.distinctLength).toBe(Array.from("Mehmet Yılm").length);
    // "Andrea…" could be Andreas; the people's names count, not only their labels.
    const [andrea, andreas] = labelsOf(["Schulz, Andrea", "Andreas Schulz"]);
    expect(andrea.distinctLength).toBe(Array.from("Andrea S").length);
    expect(andreas.distinctLength).toBe(Array.from("Andreas").length);
    // Identical names: no cut is safe.
    const [first] = labelsOf(["Anna Schmidt", "Anna Schmidt"]);
    expect(first.distinctLength).toBe(Array.from("Anna Schmidt").length + 1);
    expect(nameLabelsOf("Sophie Weber").distinctLength).toBe(1);
  });

  it("matches the labels of a lone person when nobody collides", () => {
    const [lena] = labelsOf(["Lena Hoffmann", "Tom Finck"]);
    expect(lena).toEqual(nameLabelsOf("Lena Hoffmann"));
  });
});
