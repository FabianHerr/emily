// Family web portal (CJ-20). Public, no auth: demo only.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { acknowledgeIncident, markIncidentFalseAlarm } from "./incidents";
import schema from "./schema";

// The portal shows this many incidents, newest first: enough for a busy week.
const MAX_INCIDENTS = 100;
// Upper bound when reading a device's family members.
const MAX_FAMILY_MEMBERS = 50;

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
        }),
      ),
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
        };
      }),
    };
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
