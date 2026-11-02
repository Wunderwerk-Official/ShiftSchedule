// Accent-insensitive text search for people's names: "muller" and "mueller"
// find "Müller", "Jorg" and "joerg" find "Jörg", "lukasiewicz" finds
// "Łukasiewicz", "obrien" finds "O'Brien", "jörg müller" finds "Müller,
// Jörg". Used by every person search field.

// Letters that Unicode does not decompose into a base letter plus a mark.
const LETTER_FOLDS: Record<string, string> = {
  "ß": "ss",
  "ı": "i",
  "ł": "l",
  "ø": "o",
  "æ": "ae",
  "œ": "oe",
  "đ": "d",
  "ð": "d",
  "þ": "th",
};
// Usual transliterations: German umlauts and Scandinavian ø / å ("Sørensen" =
// "Soerensen", "Ødegård" = "Oedegaard").
const TRANSLITERATIONS: Record<string, string> = { "ä": "ae", "ö": "oe", "ü": "ue", "ø": "oe", "å": "aa" };

function fold(text: string, transliterate: boolean): string {
  let folded = text.normalize("NFC").toLowerCase();
  if (transliterate) folded = folded.replace(/[äöüøå]/g, (letter) => TRANSLITERATIONS[letter]);
  return folded
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßıłøæœđðþ]/g, (letter) => LETTER_FOLDS[letter])
    .replace(/['’ʼ`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Zoë O'Brien" → "zoe obrien": case, accents and apostrophes folded, "ß" → "ss", "ı" → "i", … */
export function normalizeForSearch(text: string): string {
  return fold(text, false);
}

/**
 * Whether `text` contains every word of `query`, in any order, ignoring case
 * and accents. German umlauts and Scandinavian ø / å also match their
 * transliteration ("ü" = "ue", "ø" = "oe", "å" = "aa"), on either side. An
 * empty query matches everything.
 */
// Every mix of plain and transliterated special letters of a name
// ("Ødegård" → "odegard", "oedegard", "odegaard", "oedegaard"), capped so
// long names stay cheap.
const MAX_SPELLINGS = 64;
function spellings(text: string): string[] {
  let variants = [""];
  for (const letter of text.normalize("NFC").toLowerCase()) {
    const transliterated = TRANSLITERATIONS[letter];
    variants =
      transliterated && variants.length * 2 <= MAX_SPELLINGS
        ? variants.flatMap((prefix) => [prefix + letter, prefix + transliterated])
        : variants.map((prefix) => prefix + letter);
  }
  return [...new Set([fold(text, true), ...variants.map((variant) => fold(variant, false))])];
}

export function matchesSearch(text: string, query: string): boolean {
  const haystacks = spellings(text);
  return query
    .split(/\s+/)
    .every((word) =>
      [fold(word, false), fold(word, true)].some((needle) =>
        haystacks.some((haystack) => haystack.includes(needle)),
      ),
    );
}
