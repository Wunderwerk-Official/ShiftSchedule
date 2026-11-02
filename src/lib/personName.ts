import { normalizeForSearch } from "./textSearch";

// One parser for people's names, behind every shortened form: pill labels,
// the clinic sheet's surnames, initials, My plan's first names and the order
// of names in a cell. It reads "Last, First" ("Müller, Jörg; Dr."), academic
// titles before or after the name ("Dr. med. dent.", "Prof. Dr.", "PD",
// "Priv.-Doz.", "MD", "PhD", …), nicknames in quotes, notes in parentheses,
// name particles ("van", "von der", "Freifrau von", …) as part of the family
// name, and degrees after a comma ("Anna Schmidt, MPH"). Full names stay as
// entered wherever the UI shows a full name.

export type PersonName = {
  /** Given names in order ("Hans-Joachim"; "Anna Maria" → ["Anna", "Maria"]). */
  readonly given: readonly string[];
  /** Family name with its particles ("van Beethoven"); empty for a one-word name. */
  readonly family: string;
  /** Main family name without particles, for initials and sorting ("Beethoven"). */
  readonly familyCore: string;
  /** Academic titles as written ("Dr.", "med."). */
  readonly titles: readonly string[];
  /** Nicknames in quotes as written ("„Hansi“"): not part of the name. */
  readonly nicknames: readonly string[];
  /** Notes in parentheses as written ("(OA)", "(geb. Meier)"): not part of the name. */
  readonly notes: readonly string[];
};

// Titles and degrees, lowercase without the final dot. Austrian ("Dr.in",
// "Mag.", "Univ.-Doz."), Czech and Slovak ("MUDr.", "doc."), Italian and
// Spanish ("Dott.ssa", "Dra.") forms included.
const TITLES = new Set([
  "dr", "dres", "ddr", "dr.in", "prof", "pd", "doz", "priv.-doz", "privatdozent", "univ.-prof",
  "univ.-doz", "jun.-prof", "apl", "md", "m.d", "phd", "ph.d", "dmd", "mba", "msc", "m.sc",
  "fmh", "jr", "sr", "mag.a", "mudr", "mddr", "mvdr", "phdr", "rndr", "judr", "pharmdr",
  "paeddr", "dott", "dott.ssa", "dr.ssa", "dra",
]);
// Titles that read as a name without their dot ("Ing Chen"): titles only with it.
const DOTTED_TITLES = new Set(["mag", "ing", "doc", "mgr", "bc"]);
// Faculties and honours that follow a title: "Dr. med. dent.", "Dr. rer. nat.",
// "Dr. h.c.", "Prof. em.", "Mag. pharm.".
const TITLE_PARTS = new Set([
  "med", "dent", "vet", "rer", "nat", "phil", "hum", "biol", "pharm", "sc", "habil", "h.c",
  "univ", "mult", "jur", "oec", "pol", "theol", "ing", "techn", "soc", "medic", "paed", "em",
  "emer", "emerit",
]);
// Particles and German noble titles: part of the family name, never its
// initial. Short forms leave the noble titles out ("M. von Hohenzollern").
const PARTICLES = new Set([
  "von", "vom", "zu", "zum", "zur", "und", "van", "der", "den", "de", "del", "della", "dei",
  "degli", "di", "da", "das", "do", "dos", "du", "des", "la", "le", "ten", "ter", "te", "op",
  "af", "av", "y",
]);
const NOBLE_TITLES = new Set([
  "freiherr", "freifrau", "freiin", "graf", "gräfin", "baron", "baronin", "prinz", "prinzessin",
  "fürst", "fürstin", "edler", "edle", "ritter",
]);
// "Hans "Hansi" Müller", „Hansi“, »Hansi«: a nickname; "(OA)", "(geb. Meier)":
// a note. Neither is part of the name; full names keep them.
const NICKNAME = /["“„«»][^"“”„«»]*["”“»«]/g;
const NOTE = /\([^)]*\)/g;

function isTitle(token: string): boolean {
  const key = token.toLowerCase().replace(/\.$/, "");
  if (TITLES.has(key) || /^(?:dipl|dr)\.-\p{L}+$/u.test(key)) return true;
  if (DOTTED_TITLES.has(key)) return token.endsWith(".");
  // Written without spaces: "Dr.med.", "Dr.rer.nat.", "Prof.Dr."
  const parts = key.split(".");
  return (
    parts.length > 1 &&
    TITLES.has(parts[0]) &&
    parts.slice(1).every((part) => TITLES.has(part) || TITLE_PARTS.has(part))
  );
}

// "med." after "Dr."; a capitalized word without a dot ("Dr. Nat King") is a name.
const isTitlePart = (token: string) =>
  TITLE_PARTS.has(token.toLowerCase().replace(/\.$/, "")) &&
  (token.endsWith(".") || token === token.toLowerCase());

const isNobleTitle = (token: string) => NOBLE_TITLES.has(token.toLowerCase());
const isParticle = (token: string) => PARTICLES.has(token.toLowerCase()) || isNobleTitle(token);

// A degree after a comma that is not in TITLES: "MPH", "FRCR", "EDiR",
// "MBChB", "M.A.", "B.Sc." (capitals at least as many as small letters).
function isDegree(token: string): boolean {
  const capitals = token.match(/\p{Lu}/gu)?.length ?? 0;
  const small = token.match(/\p{Ll}/gu)?.length ?? 0;
  return /^[\p{L}.]+$/u.test(token) && capitals >= 2 && capitals >= small;
}

// "Anna Schmidt": a whole name before a comma, so what follows can be degrees.
// Not "van Berg" (one name and a particle) or "VAN DER BERG" (a name in
// capitals: "JAN" after it is a given name, not a degree).
const isWholeName = (words: readonly string[]) =>
  words.filter((word) => !isParticle(word)).length >= 2 &&
  words.some((word) => word !== word.toUpperCase());

function wordsWithoutTitles(segment: string, titles: string[]): string[] {
  const words: string[] = [];
  let afterTitle = false;
  for (const token of segment.split(/\s+/)) {
    if (!/\p{L}/u.test(token)) continue; // "&", "-"
    afterTitle = isTitle(token) || (afterTitle && isTitlePart(token));
    if (afterTitle) titles.push(token);
    else words.push(token);
  }
  return words;
}

const parsed = new Map<string, PersonName>();

/** Given names, family name and titles of a name as people type it. */
export function parsePersonName(name: string): PersonName {
  const cached = parsed.get(name);
  if (cached) return cached;
  const titles: string[] = [];
  const nicknames: string[] = [];
  const notes: string[] = [];
  const segments: string[][] = [];
  const plain = name
    .normalize("NFC")
    .replace(NICKNAME, (nickname) => {
      nicknames.push(nickname);
      return " ";
    })
    .replace(NOTE, (note) => {
      notes.push(note);
      return " ";
    });
  for (const segment of plain.split(/[,;]/)) {
    const words = wordsWithoutTitles(segment, titles);
    if (words.length === 0) continue;
    // "Anna Schmidt, MPH", "Lisa Wolf, M.A.": degrees, not "Last, First".
    if (segments.length > 0 && isWholeName(segments[0]) && words.every(isDegree)) titles.push(...words);
    else segments.push(words);
  }
  let given: string[];
  let family: string[];
  if (segments.length >= 2) {
    // "Müller, Jörg": family name first. Particles after the given names
    // ("Goethe, Johann Wolfgang von") belong to the family name.
    family = [...segments[0]];
    given = [...segments[1]];
    while (given.length > 1 && isParticle(given[given.length - 1])) {
      family.unshift(given.pop() as string);
    }
  } else if (segments.length === 1 && segments[0].length > 1) {
    // "Ludwig van Beethoven": the last word and the particles before it.
    const words = segments[0];
    let start = words.length - 1;
    while (start > 1 && isParticle(words[start - 1])) start -= 1;
    given = words.slice(0, start);
    family = words.slice(start);
  } else if (segments.length === 1) {
    given = segments[0];
    family = [];
  } else {
    // Nothing but titles or no letters: keep the words as written.
    given = name.trim().split(/\s+/).filter(Boolean);
    family = [];
    titles.length = 0;
    nicknames.length = 0;
    notes.length = 0;
  }
  const core = family.find((word) => !isParticle(word)) ?? family[family.length - 1] ?? "";
  const result: PersonName = { given, family: family.join(" "), familyCore: core, titles, nicknames, notes };
  parsed.set(name, result);
  return result;
}

/**
 * The full name without titles, given names first: "Dr. med. Anna Schmidt" →
 * "Anna Schmidt", "Müller, Jörg; Dr." → "Jörg Müller". Nicknames and notes
 * stay ("Anna Schmidt (OA)"): they may be what tells two people apart.
 */
export function displayName(name: string): string {
  const { given, family, nicknames, notes } = parsePersonName(name);
  return [...given, ...nicknames, family, ...notes].filter(Boolean).join(" ") || name.trim();
}

/** First given name: "Müller, Jörg; Dr." → "Jörg". */
export function givenNameOf(name: string): string {
  return parsePersonName(name).given[0] ?? name.trim();
}

/** Sorting key: the main family name ("van Beethoven" → "Beethoven"), else the given name. */
export function surnameSortKey(name: string): string {
  const { given, familyCore } = parsePersonName(name);
  return familyCore || given[0] || name;
}

const isLetter = (char: string) => /\p{L}/u.test(char);
const firstLetter = (word: string) => Array.from(word).find(isLetter) ?? word.charAt(0);

/** "Müller, Jörg; Dr." → "JM", "Ludwig van Beethoven" → "LB", "Jonas" → "J"; "?" without letters. */
export function initialsOf(name: string): string {
  const { given, familyCore } = parsePersonName(name);
  const initials = [given[0], familyCore]
    .filter((word): word is string => Boolean(word))
    .map((word) => {
      const letter = firstLetter(word);
      const upper = letter.toUpperCase();
      return upper.length === letter.length ? upper : letter; // "ß" stays one letter
    })
    .join("");
  return initials || "?";
}

// "Schmidt" → "S.", "Sc.", …, "Schmid.", "Schmidt": one more letter each
// step (a hyphen or apostrophe rides along with the next letter), the whole
// word last. A shortened form that is no shorter than the word is skipped
// ("Ek", not "E."; "Andre.", then "Andreas").
function letterSteps(word: string, dot = true): string[] {
  const chars = Array.from(word);
  const steps: string[] = [];
  chars.forEach((char, index) => {
    if (!isLetter(char) || !chars.slice(index + 1).some(isLetter)) return;
    const prefix = chars.slice(0, index + 1).join("");
    if (!dot) steps.push(prefix);
    else if (index + 2 < chars.length) steps.push(`${prefix}.`);
  });
  return [...steps, word];
}

/**
 * Pill abbreviation levels: 0 the full name, 1 "First L.", 2 "F. Last",
 * 3 "F. L.", 4 "FL".
 */
export const NAME_LABEL_LEVELS = 5;

type LabelStyle = 1 | 2 | 3 | 4 | "surname";

// Labels compare text without case and accents; the same few words come up
// again and again while a team's labels are built.
const foldedTexts = new Map<string, string>();
function fold(text: string): string {
  let folded = foldedTexts.get(text);
  if (folded === undefined) {
    folded = normalizeForSearch(text);
    foldedTexts.set(text, folded);
  }
  return folded;
}

// A name as the matching sees it: case and accents folded.
type FoldedName = {
  oneWord: boolean;
  first: string;
  core: string;
  family: string;
  /** What the clinic sheet shows alone: the family name, or the one word. */
  surname: string;
};

// "Freifrau von Hohenzollern" → "von Hohenzollern": the family name in short forms.
function shortFamily(family: string): string {
  const words = family.split(" ");
  while (words.length > 1 && isNobleTitle(words[0])) words.shift();
  return words.join(" ");
}

function foldName(name: string): FoldedName {
  const { given, family, familyCore } = parsePersonName(name);
  const first = fold(given[0] ?? "");
  const folded = fold(shortFamily(family));
  return {
    oneWord: !familyCore,
    first,
    core: fold(familyCore),
    family: folded,
    surname: folded || first,
  };
}

// "Sc." stands for every word starting with "Sc"; a whole word only for itself.
function partMatcher(part: string): (foldedWord: string) => boolean {
  if (part.endsWith(".")) {
    const prefix = fold(part.slice(0, -1));
    return (word) => word.startsWith(prefix);
  }
  const whole = fold(part);
  return (word) => word === whole;
}

type Candidate = { text: string; fits: (other: FoldedName) => boolean };

const byCore = (other: FoldedName) => other.core;
const byFamily = (other: FoldedName) => other.family;

function twoPart(
  text: string,
  givenPart: string,
  familyPart: string,
  familyOf: (other: FoldedName) => string,
): Candidate {
  const givenFits = partMatcher(givenPart);
  const familyFits = partMatcher(familyPart);
  return { text, fits: (other) => !other.oneWord && givenFits(other.first) && familyFits(familyOf(other)) };
}

// Texts one person may show in a style, in the order they are tried: first
// more letters of the family name, then of the given name. Each knows which
// names it could stand for, always some of those the first one stands for.
function* candidates(style: LabelStyle, name: string): Generator<Candidate> {
  const { given, family: fullFamily, familyCore } = parsePersonName(name);
  const first = given[0] ?? "";
  const family = shortFamily(fullFamily);
  if (!familyCore) {
    // One word ("Jonas"): whole, or its letters in the initials styles ("J", "Jo", …).
    if (style === 3 || style === 4) {
      for (const part of letterSteps(first, false)) {
        const fits = partMatcher(part === first ? part : `${part}.`);
        yield { text: part, fits: (other) => other.oneWord && fits(other.first) };
      }
    } else {
      const word = fold(first);
      yield {
        text: first,
        fits: (other) => (style === "surname" ? other.surname === word : other.oneWord && other.first === word),
      };
    }
    return;
  }
  switch (style) {
    case 1:
      for (const part of letterSteps(familyCore)) yield twoPart(`${first} ${part}`, first, part, byCore);
      return;
    case 2:
      for (const part of letterSteps(first)) yield twoPart(`${part} ${family}`, part, family, byFamily);
      return;
    case 3:
      for (const givenPart of letterSteps(first)) {
        for (const part of letterSteps(familyCore)) {
          yield twoPart(`${givenPart} ${part}`, givenPart, part, byCore);
        }
      }
      return;
    case 4: {
      const initials = [firstLetter(first), firstLetter(familyCore)];
      yield twoPart(initials.join(""), `${initials[0]}.`, `${initials[1]}.`, byCore);
      yield* candidates(3, name);
      return;
    }
    case "surname": {
      // A family name that is only an initial ("Marion P.") needs the whole name.
      if (Array.from(familyCore).filter(isLetter).length < 2) return;
      const alone = fold(family);
      yield { text: family, fits: (other) => other.surname === alone };
      for (const part of letterSteps(first)) yield twoPart(`${part} ${family}`, part, family, byFamily);
    }
  }
}

// Texts compared without case and accents ("Mehmet Yi." = "Mehmet Yı.").
// People who would share a text move on to their next one; people whose
// texts never part (the same full name) keep the full name.
function uniqueTexts(lists: string[][]): string[] {
  const steps = lists.map(() => 0);
  for (;;) {
    const holders = new Map<string, number[]>();
    lists.forEach((list, index) => {
      const key = fold(list[steps[index]]);
      holders.set(key, [...(holders.get(key) ?? []), index]);
    });
    let advanced = false;
    for (const indexes of holders.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        if (steps[index] < lists[index].length - 1) {
          steps[index] += 1;
          advanced = true;
        }
      }
    }
    if (!advanced) return lists.map((list, index) => list[steps[index]]);
  }
}

// The bare name: given and family names without titles, nicknames or notes.
// Short labels drop notes, so "Anna Schmidt" reads as "Anna Schmidt (OA)" too.
function bareName(name: string): string {
  const { given, family } = parsePersonName(name);
  return fold([...given, family].filter(Boolean).join(" "));
}

// Each person's first candidate that stands for nobody else in the team:
// "Mehmet Yi." could be Mehmet Yılmaz too, so Mehmet Yildirim reads "Mehmet
// Yild.". Without one, the name without titles, then the name as entered. The
// name without titles is skipped while it is another person's bare name:
// "Dr. Anna Schmidt" keeps her title next to "Anna Schmidt (OA)".
function teamTexts(style: LabelStyle, names: readonly string[], folded: readonly FoldedName[]): string[] {
  const textsOf = (name: string, index: number): string[] => {
    // The people the first candidate could stand for: later ones only narrow it.
    let rivals: FoldedName[] | undefined;
    for (const candidate of candidates(style, name)) {
      rivals ??= folded.filter((other, otherIndex) => otherIndex !== index && candidate.fits(other));
      if (!rivals.some(candidate.fits)) return [candidate.text];
    }
    const plain = displayName(name);
    const readsAsOther = names.some(
      (other, otherIndex) => otherIndex !== index && bareName(other) === fold(plain),
    );
    return [...new Set(readsAsOther ? [name.trim()] : [plain, name.trim()])];
  };
  return uniqueTexts(names.map(textsOf));
}

export type PersonNameLabels = {
  /** Pill text per abbreviation level (NAME_LABEL_LEVELS), each standing for one person of the team. */
  readonly levels: readonly string[];
  /**
   * Characters of "First L." (levels[1]) a pill must show when it cuts the
   * label with an ellipsis: any fewer could be someone else ("Sophie W…" for
   * Sophie Wagner beside Sophie Weber). One more than the label's length when
   * no cut is safe.
   */
  readonly distinctLength: number;
  /** Clinic sheet text: the family name, "J. Müller" while another person shares it. */
  readonly surname: string;
};

// How many characters `label` needs before none of the other people's texts
// starts the same way (compared without case and accents).
function distinctLength(label: string, others: readonly string[]): number {
  const chars = Array.from(label);
  let rivals = others;
  for (let length = 1; length <= chars.length; length += 1) {
    const start = fold(chars.slice(0, length).join(""));
    rivals = rivals.filter((other) => other.startsWith(start));
    if (rivals.length === 0) return length;
  }
  return chars.length + 1;
}

/**
 * Short names for a whole team, by person id: no label of any level could
 * stand for another person of the team, so a printed plan (no hover) never
 * shows two people under one label. Compute once per team (memoize).
 */
export function buildNameLabels(
  people: ReadonlyArray<{ id: string; name: string }>,
): Map<string, PersonNameLabels> {
  const names = people.map((person) => person.name);
  const folded = names.map(foldName);
  const styles: LabelStyle[] = [1, 2, 3, 4, "surname"];
  const [first, second, third, fourth, surname] = styles.map((style) => teamTexts(style, names, folded));
  // What a reader could take a cut "First L." for: the other people's names
  // (as entered and without titles) and their own "First L.".
  const known = names.map((name, index) => [name, displayName(name), first[index]].map(fold));
  return new Map(
    people.map((person, index) => [
      person.id,
      {
        levels: [person.name, first[index], second[index], third[index], fourth[index]],
        distinctLength: distinctLength(first[index], known.filter((_, other) => other !== index).flat()),
        surname: surname[index],
      },
    ]),
  );
}

/** Short names of one person on their own (no team to tell apart from). */
export function nameLabelsOf(name: string): PersonNameLabels {
  return buildNameLabels([{ id: name, name }]).get(name) as PersonNameLabels;
}
