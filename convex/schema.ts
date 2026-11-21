import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Field names are a contract with the watch and the later tasks (HANDOFF.md section 6).
export default defineSchema({
  devices: defineTable({
    deviceId: v.string(), // e.g. "watch-1"
    personName: v.string(), // e.g. "Rosa"
    lastHeartbeat: v.optional(v.number()), // ms since epoch
    battery: v.optional(v.number()),
  }).index("by_deviceId", ["deviceId"]),

  familyMembers: defineTable({
    name: v.string(),
    pushoverUserKey: v.string(),
    deviceId: v.string(),
  }).index("by_deviceId", ["deviceId"]),

  incidents: defineTable({
    deviceId: v.string(),
    status: v.union(
      v.literal("asking"),
      v.literal("precautionary"),
      v.literal("emergency"),
      v.literal("closed"),
      v.literal("acknowledged"),
    ),
    round: v.number(), // 1 or 2
    impact_max_g: v.number(),
    seconds_still: v.number(),
    position_changed: v.boolean(),
    model_confidence: v.number(),
    audioIds: v.array(v.id("_storage")), // one per round that had audio
    transcript: v.optional(v.union(v.string(), v.null())),
    decision: v.optional(v.any()), // the AI's JSON (CJ-13)
    receipts: v.array(v.string()), // Pushover receipts (CJ-7)
    acknowledgedBy: v.optional(v.string()),
    falseAlarmBy: v.optional(v.string()), // family member who marked it a false alarm
    createdAt: v.number(), // ms since epoch
  }).index("by_deviceId_and_createdAt", ["deviceId", "createdAt"]),

  // Queue of things for the watch to say (read by GET /poll in CJ-14).
  messages: defineTable({
    deviceId: v.string(),
    incidentId: v.optional(v.id("incidents")),
    text: v.string(),
    audioId: v.optional(v.id("_storage")),
    askAgain: v.boolean(),
    delivered: v.boolean(),
  }).index("by_deviceId_and_delivered", ["deviceId", "delivered"]),

  // Activity feed for the family portal (CJ-28). One row per step, text ready to show.
  // Written only through logEvent (convex/events.ts).
  events: defineTable({
    deviceId: v.string(),
    incidentId: v.optional(v.id("incidents")),
    type: v.union(
      v.literal("fall_detected"),
      v.literal("person_said"),
      v.literal("no_answer"),
      v.literal("alert_sent"),
      v.literal("acknowledged"),
      v.literal("watch_said"),
      v.literal("incident_closed"),
    ),
    text: v.string(), // English, e.g. "Fall detected (impact 3.4 g)"
    level: v.union(v.literal("info"), v.literal("precautionary"), v.literal("emergency")),
    createdAt: v.number(), // ms since epoch
  }).index("by_deviceId_and_createdAt", ["deviceId", "createdAt"]),
});
