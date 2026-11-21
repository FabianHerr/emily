// Pure decision rules for the AI Service (convex/ai.ts). No I/O and no imports, so it
// loads in either Convex runtime and in a plain Node script.
//
// Round rules (HANDOFF.md section 7), enforced by applyRoundRules after every decision:
// - Asks for help, is hurt or fell (any round): emergency at once.
// - Clearly fine (any round): no alert, incident closed.
// - Silent or unclear in round 1: no alert, the watch asks its own second question.
// - Silent or unclear in round 2: emergency. There is never a third question.

// The API has no silence flag: a transcript with fewer letters than this is silence.
export const MIN_TRANSCRIPT_LETTERS = 3;
// Limits on what Claude writes (HANDOFF.md section 6).
export const MAX_FAMILY_SUMMARY_CHARS = 200;
export const MAX_REPLY_WORDS = 15;
// Rules (silence, keywords) have no model behind them, so they report no confidence.
const RULE_SEVERITY = "unknown";
const RULE_CONFIDENCE = 0;
// Keyword rules (Plan C), used when Claude and Gemini both fail. Matched as whole
// words, case-insensitive. Emergency words are checked first, so "I'm fine but I
// can't get up" is an emergency. Inflected forms are listed because word-boundary
// matching would otherwise miss "my hip hurts".
const EMERGENCY_WORDS = [
  "help",
  "hurt",
  "hurts",
  "hurting",
  "pain",
  "painful",
  "can't",
  "cant",
  "cannot",
  "can not",
  "fell",
  "ambulance",
  "broke",
  "broken",
  "bleeding",
  "blood",
  "dizzy",
  "stuck",
  "emergency",
  "hospital",
  "doctor",
];
const OK_PHRASES = ["i'm ok", "i'm okay", "i'm fine", "i am fine", "all good"];
// An OK phrase only counts in a short, plain answer: "it's not all good" or
// "I'm okay but ..." must not close the incident.
const OK_BLOCKERS = ["not", "no", "but", "don't", "except", "just"];
const OK_MAX_WORDS = 8;
// What Emily says back after a rules decision, or when the AI gave no reply (no family
// names: rules do not know them).
const RULES_EMERGENCY_REPLY = "I am getting help for you.";
const RULES_OK_REPLY = "Good to hear. I'm here if you need me.";

// Family alert when processFall crashed and there is nothing better to say.
export const impactMessage = (impactMaxG: number | null) =>
  impactMaxG === null
    ? "Possible fall."
    : `Possible fall. Impact of ${impactMaxG.toFixed(1)} g`;

// Family alert when the person never answered: round 2 silent, or round 2 never came.
export const notRespondingMessage = (personName: string) =>
  truncateChars(`${personName} fell and is not responding.`, MAX_FAMILY_SUMMARY_CHARS);

// Family alert when round 2 was unclear and the AI wrote no summary to quote.
const unclearMessage = (personName: string) =>
  truncateChars(`${personName} fell and did not answer clearly.`, MAX_FAMILY_SUMMARY_CHARS);

// ElevenLabs tags sounds as "[sighs]", "[silence]" or "(laughs)". They are not speech:
// drop them, and treat what is left as silence (null) when it has almost no letters.
export function speechOrNull(raw: string): string | null {
  const text = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters < MIN_TRANSCRIPT_LETTERS ? null : text;
}

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

// The person did not answer (no transcript, or no clip at all). Round 1 never alerts:
// the watch asks again, whatever the impact. Round 2 is always an emergency.
export function decideOnSilence(args: { round: 1 | 2; personName: string }): Decision {
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
      family_summary: notRespondingMessage(args.personName),
      ask_again: false,
    };
  }
  return { ...base, notify: false, level: "none", family_summary: "", ask_again: true };
}

// The round rules, in code, after any decision (Claude, Gemini, keyword rules or
// silence), so a prompt slip can never alert on round 1 by itself or ask a third time.
// Unclear means level "precautionary", or ask_again from the AI. An emergency always
// wins, even with ask_again: the person asked for help. Every final decision has a
// reply, because the watch asks round 2 on its own if no reply arrives.
export function applyRoundRules(
  decision: Decision,
  round: 1 | 2,
  personName: string,
): Decision {
  if (decision.level === "emergency") {
    return {
      ...decision,
      notify: true,
      ask_again: false,
      reply_to_person: decision.reply_to_person ?? RULES_EMERGENCY_REPLY,
    };
  }
  const unclear = decision.level === "precautionary" || decision.ask_again;
  if (!unclear) {
    // A final "none": the person is fine.
    return {
      ...decision,
      notify: false,
      ask_again: false,
      reply_to_person: decision.reply_to_person ?? RULES_OK_REPLY,
    };
  }
  if (round === 1) {
    // Ask again, quietly: the watch plays its own second question, so no reply.
    return {
      ...decision,
      notify: false,
      level: "none",
      family_summary: "",
      reply_to_person: null,
      ask_again: true,
    };
  }
  // Round 2 still unclear: there is no third question, so alert.
  return {
    ...decision,
    notify: true,
    level: "emergency",
    family_summary: decision.family_summary || unclearMessage(personName),
    reply_to_person: decision.reply_to_person ?? RULES_EMERGENCY_REPLY,
    ask_again: false,
  };
}

// Lower case, curly apostrophes made straight, so "I’M FINE" matches "i'm fine".
function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ`]/g, "'");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole words only: "help" does not match "helpful", "pain" does not match "painting".
// An apostrophe counts as part of a word, so "can't" is one word.
function containsPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?<![a-z0-9'])${escapeRegExp(phrase)}(?![a-z0-9'])`).test(text);
}

// Claude and Gemini both failed but we have the person's words (Plan C). Same round
// rules as the AI: an unclear answer asks again in round 1 and alerts in round 2.
export function fallbackDecision(args: { transcript: string; round: 1 | 2 }): Decision {
  const text = normalize(args.transcript);
  const base = {
    severity: RULE_SEVERITY,
    confidence: RULE_CONFIDENCE,
    family_summary: truncateChars(`Said: "${args.transcript}"`, MAX_FAMILY_SUMMARY_CHARS),
    ask_again: false,
  };
  if (EMERGENCY_WORDS.some((w) => containsPhrase(text, w))) {
    return { ...base, notify: true, level: "emergency", reply_to_person: RULES_EMERGENCY_REPLY };
  }
  const isPlainOk =
    OK_PHRASES.some((p) => containsPhrase(text, p)) &&
    !OK_BLOCKERS.some((w) => containsPhrase(text, w)) &&
    text.split(/\s+/).filter((w) => w.length > 0).length <= OK_MAX_WORDS;
  if (isPlainOk) {
    return { ...base, notify: false, level: "none", reply_to_person: RULES_OK_REPLY };
  }
  // Unclear answer.
  return args.round === 1
    ? { ...base, notify: false, level: "none", family_summary: "", reply_to_person: null, ask_again: true }
    : { ...base, notify: true, level: "emergency", reply_to_person: RULES_EMERGENCY_REPLY };
}

// Checks Claude's or Gemini's JSON. Returns null when it cannot be used. Fixes what is safe to
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
