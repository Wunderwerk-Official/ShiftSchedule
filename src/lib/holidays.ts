// Public holidays from date.nager.at and the regions they are filtered by.

/** One entry of GET https://date.nager.at/api/v3/PublicHolidays/{year}/{country}. */
export type NagerPublicHoliday = {
  date: string;
  localName?: string;
  name?: string;
  /** true: nationwide. false: only in the subdivisions listed in `counties`. */
  global?: boolean;
  /** ISO 3166-2 codes ("DE-BY") of a regional holiday; null when nationwide. */
  counties?: string[] | null;
};

export type HolidayRegion = { code: string; name: string };

export type HolidayRegionSet = {
  /** What the subdivisions are called in the UI ("state" → "All states"). */
  noun: string;
  plural: string;
  regions: HolidayRegion[];
};

// Countries of the Settings → Holidays picker whose date.nager.at data has
// regional holidays, with every subdivision as ISO 3166-2 code (the codes
// date.nager.at puts into `counties`). Names are the local ones.
export const HOLIDAY_REGIONS: Record<string, HolidayRegionSet> = {
  DE: {
    noun: "state",
    plural: "states",
    regions: [
      { code: "DE-BW", name: "Baden-Württemberg" },
      { code: "DE-BY", name: "Bayern" },
      { code: "DE-BE", name: "Berlin" },
      { code: "DE-BB", name: "Brandenburg" },
      { code: "DE-HB", name: "Bremen" },
      { code: "DE-HH", name: "Hamburg" },
      { code: "DE-HE", name: "Hessen" },
      { code: "DE-MV", name: "Mecklenburg-Vorpommern" },
      { code: "DE-NI", name: "Niedersachsen" },
      { code: "DE-NW", name: "Nordrhein-Westfalen" },
      { code: "DE-RP", name: "Rheinland-Pfalz" },
      { code: "DE-SL", name: "Saarland" },
      { code: "DE-SN", name: "Sachsen" },
      { code: "DE-ST", name: "Sachsen-Anhalt" },
      { code: "DE-SH", name: "Schleswig-Holstein" },
      { code: "DE-TH", name: "Thüringen" },
    ],
  },
  CH: {
    noun: "canton",
    plural: "cantons",
    regions: [
      { code: "CH-AG", name: "Aargau" },
      { code: "CH-AR", name: "Appenzell Ausserrhoden" },
      { code: "CH-AI", name: "Appenzell Innerrhoden" },
      { code: "CH-BL", name: "Basel-Landschaft" },
      { code: "CH-BS", name: "Basel-Stadt" },
      { code: "CH-BE", name: "Bern" },
      { code: "CH-FR", name: "Fribourg" },
      { code: "CH-GE", name: "Genève" },
      { code: "CH-GL", name: "Glarus" },
      { code: "CH-GR", name: "Graubünden" },
      { code: "CH-JU", name: "Jura" },
      { code: "CH-LU", name: "Luzern" },
      { code: "CH-NE", name: "Neuchâtel" },
      { code: "CH-NW", name: "Nidwalden" },
      { code: "CH-OW", name: "Obwalden" },
      { code: "CH-SH", name: "Schaffhausen" },
      { code: "CH-SZ", name: "Schwyz" },
      { code: "CH-SO", name: "Solothurn" },
      { code: "CH-SG", name: "St. Gallen" },
      { code: "CH-TG", name: "Thurgau" },
      { code: "CH-TI", name: "Ticino" },
      { code: "CH-UR", name: "Uri" },
      { code: "CH-VS", name: "Valais" },
      { code: "CH-VD", name: "Vaud" },
      { code: "CH-ZG", name: "Zug" },
      { code: "CH-ZH", name: "Zürich" },
    ],
  },
  ES: {
    noun: "region",
    plural: "regions",
    regions: [
      { code: "ES-AN", name: "Andalucía" },
      { code: "ES-AR", name: "Aragón" },
      { code: "ES-AS", name: "Asturias" },
      { code: "ES-CN", name: "Canarias" },
      { code: "ES-CB", name: "Cantabria" },
      { code: "ES-CL", name: "Castilla y León" },
      { code: "ES-CM", name: "Castilla-La Mancha" },
      { code: "ES-CT", name: "Catalunya" },
      { code: "ES-CE", name: "Ceuta" },
      { code: "ES-MD", name: "Comunidad de Madrid" },
      { code: "ES-VC", name: "Comunitat Valenciana" },
      { code: "ES-EX", name: "Extremadura" },
      { code: "ES-GA", name: "Galicia" },
      { code: "ES-IB", name: "Illes Balears" },
      { code: "ES-RI", name: "La Rioja" },
      { code: "ES-ML", name: "Melilla" },
      { code: "ES-NC", name: "Navarra" },
      { code: "ES-PV", name: "País Vasco" },
      { code: "ES-MC", name: "Región de Murcia" },
    ],
  },
  GB: {
    noun: "region",
    plural: "regions",
    regions: [
      { code: "GB-ENG", name: "England" },
      { code: "GB-NIR", name: "Northern Ireland" },
      { code: "GB-SCT", name: "Scotland" },
      { code: "GB-WLS", name: "Wales" },
    ],
  },
  IT: {
    noun: "region",
    plural: "regions",
    regions: [
      { code: "IT-65", name: "Abruzzo" },
      { code: "IT-77", name: "Basilicata" },
      { code: "IT-78", name: "Calabria" },
      { code: "IT-72", name: "Campania" },
      { code: "IT-45", name: "Emilia-Romagna" },
      { code: "IT-36", name: "Friuli-Venezia Giulia" },
      { code: "IT-62", name: "Lazio" },
      { code: "IT-42", name: "Liguria" },
      { code: "IT-25", name: "Lombardia" },
      { code: "IT-57", name: "Marche" },
      { code: "IT-67", name: "Molise" },
      { code: "IT-21", name: "Piemonte" },
      { code: "IT-75", name: "Puglia" },
      { code: "IT-88", name: "Sardegna" },
      { code: "IT-82", name: "Sicilia" },
      { code: "IT-52", name: "Toscana" },
      { code: "IT-32", name: "Trentino-Alto Adige" },
      { code: "IT-55", name: "Umbria" },
      { code: "IT-23", name: "Valle d'Aosta" },
      { code: "IT-34", name: "Veneto" },
    ],
  },
};

// ISO 3166-2 shape: country, hyphen, 1-3 letters or digits ("DE-NW", "IT-32").
const HOLIDAY_REGION_PATTERN = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

/**
 * AppState.holidayRegion as stored: an uppercased ISO 3166-2 code, anything
 * else means "no region" (undefined). No trimming; mirrors
 * `_normalize_holiday_region` in backend/state.py.
 */
export function normalizeHolidayRegion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return HOLIDAY_REGION_PATTERN.test(upper) ? upper : undefined;
}

/** The region when it belongs to the country ("DE-NW" for "DE"), else undefined. */
export function holidayRegionForCountry(
  countryCode: string,
  region: string | undefined,
): string | undefined {
  const prefix = `${countryCode.trim().toUpperCase()}-`;
  return region?.startsWith(prefix) ? region : undefined;
}

/**
 * Holidays that apply in `region`: nationwide ones (`global === true`) and
 * regional ones whose `counties` list the region. Without a region every
 * entry is kept, i.e. the regional holidays of all regions.
 */
export function filterHolidaysByRegion<T extends Pick<NagerPublicHoliday, "global" | "counties">>(
  holidays: T[],
  region?: string,
): T[] {
  return holidays.filter(
    (holiday) =>
      holiday.global === true ||
      !region ||
      (Array.isArray(holiday.counties) && holiday.counties.includes(region)),
  );
}
