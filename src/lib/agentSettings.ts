// Default free-text instructions for the AI Agent solver. MUST stay in sync
// with DEFAULT_AGENT_INSTRUCTIONS in backend/agent/prompts.py — the backend
// applies this text whenever the admin has not saved their own version, and
// the settings textarea pre-fills with it so the admin sees what applies.
export const DEFAULT_AGENT_INSTRUCTIONS =
  "Prefer long, continuous assignments. Never schedule someone for just one " +
  "or two hours: it is better that one person covers a longer block (at " +
  "least half a day) and another person stays completely off. Prefer " +
  "keeping the same person on consecutive days over spreading short stints " +
  "across many people.";
