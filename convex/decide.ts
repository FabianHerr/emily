// Pure decision rules for the AI Service (convex/ai.ts). No I/O and no imports, so it
// loads in either Convex runtime and in a plain Node script.

// A silent person after an impact this strong gets a precautionary alert in round 1.
export const STRONG_IMPACT_G = 3.0;
// Limits on what Claude writes (HANDOFF.md section 6).
export const MAX_FAMILY_SUMMARY_CHARS = 200;
export const MAX_REPLY_WORDS = 15;
// Rules (silence, fallback) have no model behind them, so they report no confidence.
const RULE_SEVERITY = "unknown";
const RULE_CONFIDENCE = 0;
// What Emily says when Claude failed but the person did speak.
const FALLBACK_REPLY = "I am getting help for you.";

export const LEVELS = ["none", "precautionary", "emergency"] as const;
export type Level = (typeof LEVELS)[number];

// The AI's answer (HANDOFF.md section 6). Also produced by the rules below.
export type Decision = {
  notify: boolean;
  level: Level;
  severity: string;
  confidence: number;
  family_summary: string;
  reply_to_person: string | null;
  ask_again: boolean;
};

// JSON schema for structured outputs. Typed against Decision so a field cannot be
// added to one and forgotten in the other. Structured outputs reject min/max and
// length limits, so validateDecision enforces those after the call.
const DECISION_PROPERTIES: Record<keyof Decision, Record<string, unknown>> = {
  notify: { type: "boolean", description: "True when the family must be alerted." },
  level: { type: "string", enum: [...LEVELS] },
  severity: {
    type: "string",
    description: "One word: none, mild, moderate, severe or unknown.",
  },
  confidence: { type: "number", description: "How sure you are, from 0 to 1." },
  family_summary: {
    type: "string",
    description: `For the family, max ${MAX_FAMILY_SUMMARY_CHARS} characters.`,
  },
  reply_to_person: {
    type: "string",
    description: `What Emily says back, max ${MAX_REPLY_WORDS} words.`,
  },
  ask_again: { type: "boolean" },
};
export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: DECISION_PROPERTIES,
  required: Object.keys(DECISION_PROPERTIES),
  additionalProperties: false,
};

// Cuts by code points so an emoji is never split in half.
function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

function truncateWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.slice(0, max).join(" ");
}

// The person did not answer (no transcript). Round 1 waits for round 2 unless the
// impact was strong; round 2 is always an emergency.
export function decideOnSilence(args: {
  round: 1 | 2;
  impactMaxG: number;
  personName: string;
}): Decision {
  const base = {
    severity: RULE_SEVERITY,
    confidence: RULE_CONFIDENCE,
    reply_to_person: null,
  };
  if (args.round === 2) {
    return {
      ...base,
      notify: true,
      level: "emergency",
      family_summary: truncateChars(
        `${args.personName} fell and is not responding.`,
        MAX_FAMILY_SUMMARY_CHARS,
      ),
      ask_again: false,
    };
  }
  if (args.impactMaxG >= STRONG_IMPACT_G) {
    return {
      ...base,
      notify: true,
      level: "precautionary",
      family_summary: truncateChars(
        `Possible fall. ${args.personName} has not answered yet. We are checking.`,
        MAX_FAMILY_SUMMARY_CHARS,
      ),
      ask_again: true,
    };
  }
  return { ...base, notify: false, level: "none", family_summary: "", ask_again: true };
}

// Claude failed but we have the person's words: alert and quote them.
// impactMaxG is unused for now; the keyword rules of CJ-19 will use it.
export function fallbackDecision(args: {
  transcript: string;
  impactMaxG: number;
}): Decision {
  return {
    notify: true,
    level: "emergency",
    severity: RULE_SEVERITY,
    confidence: RULE_CONFIDENCE,
    family_summary: truncateChars(`Said: "${args.transcript}"`, MAX_FAMILY_SUMMARY_CHARS),
    reply_to_person: FALLBACK_REPLY,
    ask_again: false,
  };
}

// Checks Claude's JSON. Returns null when it cannot be used. Fixes what is safe to
// fix: notify follows level, texts are cut to their limits, confidence is clamped,
// and an empty reply becomes null.
export function validateDecision(raw: unknown): Decision | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.notify !== "boolean") return null;
  const level = LEVELS.find((l) => l === r.level);
  if (level === undefined) return null;
  if (typeof r.severity !== "string") return null;
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) return null;
  if (typeof r.family_summary !== "string") return null;
  if (typeof r.reply_to_person !== "string" && r.reply_to_person !== null) return null;
  if (typeof r.ask_again !== "boolean") return null;

  const notify = level !== "none";
  const familySummary = truncateChars(r.family_summary.trim(), MAX_FAMILY_SUMMARY_CHARS);
  // An alert with no text is useless: let the fallback quote the person instead.
  if (notify && familySummary === "") return null;
  const reply =
    r.reply_to_person === null ? "" : truncateWords(r.reply_to_person, MAX_REPLY_WORDS);

  return {
    notify,
    level,
    severity: r.severity.trim(),
    confidence: Math.min(1, Math.max(0, r.confidence)),
    family_summary: familySummary,
    reply_to_person: reply === "" ? null : reply,
    ask_again: r.ask_again,
  };
}
