// Family web portal (CJ-20). Public, no auth: demo only.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { acknowledgeIncident, markIncidentFalseAlarm } from "./incidents";
import schema from "./schema";

// The portal shows this many incidents, newest first: enough for a busy week.
const MAX_INCIDENTS = 100;
// Upper bound when reading a device's family members.
const MAX_FAMILY_MEMBERS = 50;
// Pill reminders (CJ-25): a short list the family can read at a glance.
const MAX_PILLS_PER_DEVICE = 20;
const MAX_PILL_NAME_CHARS = 40;
// "HH:MM", 24 h: 00:00 to 23:59.
const PILL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const decisionLevelValidator = v.union(
  v.literal("none"),
  v.literal("precautionary"),
  v.literal("emergency"),
);
const DECISION_LEVELS = ["none", "precautionary", "emergency"] as const;
type DecisionLevel = (typeof DECISION_LEVELS)[number];

// incidents.decision is v.any() in the schema: read only what has the expected shape.
function readDecision(decision: unknown): {
  level: DecisionLevel | null;
  familySummary: string | null;
} {
  if (typeof decision !== "object" || decision === null) {
    return { level: null, familySummary: null };
  }
  const { level, family_summary } = decision as Record<string, unknown>;
  return {
    level: DECISION_LEVELS.includes(level as DecisionLevel) ? (level as DecisionLevel) : null,
    familySummary:
      typeof family_summary === "string" && family_summary.trim() !== "" ? family_summary : null,
  };
}

export const overview = query({
  args: { deviceId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      personName: v.string(),
      lastHeartbeat: v.union(v.number(), v.null()),
      battery: v.union(v.number(), v.null()),
      familyNames: v.array(v.string()),
      incidents: v.array(
        v.object({
          _id: v.id("incidents"),
          createdAt: v.number(),
          status: schema.tables.incidents.validator.fields.status,
          round: v.number(),
          impactMaxG: v.number(),
          transcript: v.union(v.string(), v.null()),
          level: v.union(decisionLevelValidator, v.null()),
          familySummary: v.union(v.string(), v.null()),
          acknowledgedBy: v.union(v.string(), v.null()),
          falseAlarmBy: v.union(v.string(), v.null()),
          superseded: v.boolean(),
        }),
      ),
      // The most recent daily summary (CJ-32, reports.generate), or null.
      latestReport: v.union(v.null(), v.object({ text: v.string(), createdAt: v.number() })),
      // Pill reminders (CJ-25), earliest time first.
      pills: v.array(v.object({ _id: v.id("pills"), name: v.string(), time: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) return null;
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const incidents = await ctx.db
      .query("incidents")
      .withIndex("by_deviceId_and_createdAt", (q) => q.eq("deviceId", args.deviceId))
      .order("desc")
      .take(MAX_INCIDENTS);
    const latestReport = await ctx.db
      .query("events")
      .withIndex("by_deviceId_and_type_and_createdAt", (q) =>
        q.eq("deviceId", args.deviceId).eq("type", "daily_report"),
      )
      .order("desc")
      .first();
    // The index sorts by time ("HH:MM" sorts as text).
    const pills = await ctx.db
      .query("pills")
      .withIndex("by_deviceId_and_time", (q) => q.eq("deviceId", args.deviceId))
      .take(MAX_PILLS_PER_DEVICE);
    return {
      personName: device.personName,
      lastHeartbeat: device.lastHeartbeat ?? null,
      battery: device.battery ?? null,
      // Names only: Pushover keys never leave the backend.
      familyNames: members.map((m) => m.name),
      incidents: incidents.map((i) => {
        const { level, familySummary } = readDecision(i.decision);
        return {
          _id: i._id,
          createdAt: i.createdAt,
          status: i.status,
          round: i.round,
          impactMaxG: i.impact_max_g,
          transcript: i.transcript ?? null,
          level,
          familySummary,
          acknowledgedBy: i.acknowledgedBy ?? null,
          falseAlarmBy: i.falseAlarmBy ?? null,
          superseded: i.superseded === true,
        };
      }),
      latestReport: latestReport
        ? { text: latestReport.text, createdAt: latestReport.createdAt }
        : null,
      pills: pills.map((p) => ({ _id: p._id, name: p.name, time: p.time })),
    };
  },
});

// Adds a pill reminder (CJ-25). The watch says it at that Toronto time every day
// (convex/crons.ts). error is a short sentence the portal can show as is.
export const addPill = mutation({
  args: { deviceId: v.string(), name: v.string(), time: v.string() },
  returns: v.object({ ok: v.boolean(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const fail = (error: string) => ({ ok: false, error });
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) return fail("This watch is not set up.");
    // One space between words: the name is spoken by the watch.
    const name = args.name.trim().replace(/\s+/g, " ");
    const nameChars = Array.from(name).length;
    if (nameChars < 1 || nameChars > MAX_PILL_NAME_CHARS) {
      return fail(`The pill name must be 1 to ${MAX_PILL_NAME_CHARS} characters.`);
    }
    const time = args.time.trim();
    if (!PILL_TIME_PATTERN.test(time)) {
      return fail("The time must be HH:MM in 24-hour time, for example 08:30.");
    }
    const existing = await ctx.db
      .query("pills")
      .withIndex("by_deviceId_and_time", (q) => q.eq("deviceId", args.deviceId))
      .take(MAX_PILLS_PER_DEVICE);
    if (existing.length >= MAX_PILLS_PER_DEVICE) {
      return fail(`You can have up to ${MAX_PILLS_PER_DEVICE} pill reminders.`);
    }
    await ctx.db.insert("pills", { deviceId: args.deviceId, name, time });
    return { ok: true, error: null };
  },
});

// Removes a pill reminder. Already gone: nothing to do.
export const removePill = mutation({
  args: { pillId: v.id("pills") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pill = await ctx.db.get("pills", args.pillId);
    if (pill) await ctx.db.delete("pills", pill._id);
    return null;
  },
});

// The portal's "On my way" button: same effect as acknowledging in Pushover (POST /ack).
// ok: false when the incident is gone or the name is not in that device's family.
export const onMyWay = mutation({
  args: { incidentId: v.id("incidents"), name: v.string() },
  returns: v.object({ ok: v.boolean(), alreadyHandled: v.boolean() }),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident) return { ok: false, alreadyHandled: false };
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const member = members.find((m) => m.name === args.name);
    if (!member) return { ok: false, alreadyHandled: false };
    const { alreadyHandled } = await acknowledgeIncident(ctx, incident, member.name);
    return { ok: true, alreadyHandled };
  },
});

// The portal's "False alarm" button: closes the incident so the portal goes back to normal.
// ok: false when the incident is gone or the name is not in that device's family.
export const markFalseAlarm = mutation({
  args: { incidentId: v.id("incidents"), name: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident) return { ok: false };
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const member = members.find((m) => m.name === args.name);
    if (!member) return { ok: false };
    await markIncidentFalseAlarm(ctx, incident, member.name);
    return { ok: true };
  },
});
