import { normalizeForSearch } from "./textSearch";

// One parser for people's names, behind every shortened form: pill labels,
// the clinic sheet's surnames, initials, My plan's first names and the order
// of names in a cell. It reads "Last, First" ("Müller, Jörg; Dr."), academic
// titles before or after the name ("Dr. med. dent.", "Prof. Dr.", "PD",
// "Priv.-Doz.", "MD", "PhD", …), nicknames in quotes and parentheses, and
// name particles ("van", "von der", "Freifrau von", …) as part of the family
// name. Full names stay as entered wherever the UI shows a full name.

export type PersonName = {
  /** Given names in order ("Hans-Joachim"; "Anna Maria" → ["Anna", "Maria"]). */
  readonly given: readonly string[];
  /** Family name with its particles ("van Beethoven"); empty for a one-word name. */
  readonly family: string;
  /** Main family name without particles, for initials and sorting ("Beethoven"). */
  readonly familyCore: string;
  /** Academic titles as written ("Dr.", "med."). */
  readonly titles: readonly string[];
};

// Titles and degrees, lowercase without the final dot.
const TITLES = new Set([
  "dr", "dres", "prof", "pd", "doz", "priv.-doz", "privatdozent", "univ.-prof", "jun.-prof",
  "apl", "md", "m.d", "phd", "ph.d", "dmd", "mba", "msc", "m.sc", "fmh", "jr", "sr",
]);
// Faculties and honours that follow a title: "Dr. med. dent.", "Dr. rer. nat.", "Dr. h.c.".
const TITLE_PARTS = new Set([
  "med", "dent", "vet", "rer", "nat", "phil", "hum", "biol", "pharm", "sc", "habil", "h.c",
  "univ", "mult", "jur", "oec", "pol", "theol", "ing", "techn", "soc", "medic", "paed",
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
// "Hans "Hansi" Müller", „Hansi“, »Hansi«, "(geb. Meier)": not part of the name.
const NICKNAME = /["“„«»][^"“”„«»]*["”“»«]|\([^)]*\)/g;

function isTitle(token: string): boolean {
  const key = token.toLowerCase().replace(/\.$/, "");
  if (TITLES.has(key) || /^(?:dipl|dr)\.-\p{L}+$/u.test(key)) return true;
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
  const segments = name
    .normalize("NFC")
    .replace(NICKNAME, " ")
    .split(/[,;]/)
    .map((segment) => wordsWithoutTitles(segment, titles))
    .filter((words) => words.length > 0);
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
  }
  const core = family.find((word) => !isParticle(word)) ?? family[family.length - 1] ?? "";
  const result: PersonName = { given, family: family.join(" "), familyCore: core, titles };
  parsed.set(name, result);
  return result;
}

/** "Dr. med. Anna Schmidt" → "Anna Schmidt", "Müller, Jörg; Dr." → "Jörg Müller" (titles dropped). */
export function displayName(name: string): string {
  const { given, family } = parsePersonName(name);
  return [...given, family].filter(Boolean).join(" ") || name.trim();
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

// Each person's first candidate that stands for nobody else in the team:
// "Mehmet Yi." could be Mehmet Yılmaz too, so Mehmet Yildirim reads "Mehmet
// Yild.". Without one, the name without titles, then the name as entered.
function teamTexts(style: LabelStyle, names: readonly string[], folded: readonly FoldedName[]): string[] {
  const textsOf = (name: string, index: number): string[] => {
    // The people the first candidate could stand for: later ones only narrow it.
    let rivals: FoldedName[] | undefined;
    for (const candidate of candidates(style, name)) {
      rivals ??= folded.filter((other, otherIndex) => otherIndex !== index && candidate.fits(other));
      if (!rivals.some(candidate.fits)) return [candidate.text];
    }
    return [...new Set([displayName(name), name.trim()])];
  };
  return uniqueTexts(names.map(textsOf));
}

export type PersonNameLabels = {
  /** Pill text per abbreviation level (NAME_LABEL_LEVELS), each standing for one person of the team. */
  readonly levels: readonly string[];
  /** Clinic sheet text: the family name, "J. Müller" while another person shares it. */
  readonly surname: string;
};

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
  return new Map(
    people.map((person, index) => [
      person.id,
      {
        levels: [person.name, first[index], second[index], third[index], fourth[index]],
        surname: surname[index],
      },
    ]),
  );
}

/** Short names of one person on their own (no team to tell apart from). */
export function nameLabelsOf(name: string): PersonNameLabels {
  return buildNameLabels([{ id: name, name }]).get(name) as PersonNameLabels;
}
