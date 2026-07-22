SHIFT_ROW_SEPARATOR = "::"
# Per-clinician free-text planning wishes: the cap keeps the CLINICIAN
# WISHES prompt block bounded by construction (~24 clinicians x 500 chars
# stays a few thousand tokens), so no LLM summarization pass is needed.
PLANNING_WISHES_MAX_CHARS = 500
DEFAULT_LOCATION_ID = "loc-default"
DEFAULT_LOCATION_NAME = "Default"
DEFAULT_SUB_SHIFT_MINUTES = 8 * 60
DEFAULT_SUB_SHIFT_START_MINUTES = 8 * 60
DEFAULT_SUB_SHIFT_START = "08:00"
