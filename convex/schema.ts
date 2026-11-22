import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Field names are a contract with the watch and the later tasks (HANDOFF.md section 6).
export default defineSchema({
  devices: defineTable({
    deviceId: v.string(), // e.g. "watch-1"
    personName: v.string(), // e.g. "Rosa"
    lastHeartbeat: v.optional(v.number()), // ms since epoch
    battery: v.optional(v.number()),
    // CJ-24: set once "no signal" was logged, so it is logged once per outage.
    noSignalAlerted: v.optional(v.boolean()),
    // CJ-24: set once "low battery" was logged; cleared when the battery is back up.
    lowBatteryAlerted: v.optional(v.boolean()),
  }).index("by_deviceId", ["deviceId"]),

  // Pill reminders (CJ-25). The watch says them through the normal /poll queue.
  pills: defineTable({
    deviceId: v.string(),
    name: v.string(), // e.g. "blood pressure"
    time: v.string(), // "HH:MM", 24 h, America/Toronto local time
    lastAnnouncedDay: v.optional(v.string()), // "YYYY-MM-DD" in Toronto time
  })
    .index("by_deviceId_and_time", ["deviceId", "time"])
    .index("by_time", ["time"]),

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
    // Each round's own clip: round 2's clip must not be read as round 1's when round 1
    // had none (no WiFi, or round 2 created the incident).
    round1AudioId: v.optional(v.id("_storage")),
    round2AudioId: v.optional(v.id("_storage")),
    // Legacy (rows before round1AudioId/round2AudioId): one per round that had audio,
    // in arrival order. Read only as a fallback, no longer written.
    audioIds: v.optional(v.array(v.id("_storage"))),
    transcript: v.optional(v.union(v.string(), v.null())),
    decision: v.optional(v.any()), // the AI's JSON (CJ-13)
    receipts: v.array(v.string()), // Pushover receipts (CJ-7)
    acknowledgedBy: v.optional(v.string()),
    falseAlarmBy: v.optional(v.string()), // family member who marked it a false alarm
    // The watch's own id for this fall: the same on retries and on round 2, different
    // for a new fall. Missing on falls sent without it (curl, older firmware).
    fallId: v.optional(v.string()),
    // Closed because a newer fall arrived while this one was still being asked about.
    superseded: v.optional(v.boolean()),
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
      v.literal("daily_report"), // CJ-32
      v.literal("pill_reminder"), // CJ-25
      v.literal("watch_offline"), // CJ-24
      v.literal("watch_online"), // CJ-24
      v.literal("low_battery"), // CJ-24
    ),
    text: v.string(), // English, e.g. "Fall detected (impact 3.4 g)"
    level: v.union(v.literal("info"), v.literal("precautionary"), v.literal("emergency")),
    createdAt: v.number(), // ms since epoch
  })
    .index("by_deviceId_and_createdAt", ["deviceId", "createdAt"])
    // The portal's latest daily summary, without scanning the whole feed.
    .index("by_deviceId_and_type_and_createdAt", ["deviceId", "type", "createdAt"]),

  // The family's chat with Emily in the portal (convex/chat.ts). One row per message.
  chatMessages: defineTable({
    deviceId: v.string(),
    role: v.union(v.literal("family"), v.literal("emily")),
    text: v.string(),
    createdAt: v.number(), // ms since epoch
  }).index("by_deviceId_and_createdAt", ["deviceId", "createdAt"]),
});
