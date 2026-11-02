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
const GERMAN_UMLAUTS: Record<string, string> = { "ä": "ae", "ö": "oe", "ü": "ue" };

function fold(text: string, germanUmlauts: boolean): string {
  let folded = text.normalize("NFC").toLowerCase();
  if (germanUmlauts) folded = folded.replace(/[äöü]/g, (letter) => GERMAN_UMLAUTS[letter]);
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
 * and accents. German umlauts also match their transliteration ("ü" = "ue"),
 * on either side. An empty query matches everything.
 */
export function matchesSearch(text: string, query: string): boolean {
  const haystacks = [fold(text, false), fold(text, true)];
  return query
    .split(/\s+/)
    .every((word) =>
      [fold(word, false), fold(word, true)].some((needle) =>
        haystacks.some((haystack) => haystack.includes(needle)),
      ),
    );
}
