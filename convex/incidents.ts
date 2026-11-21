import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Defaults for POST /fall when the watch leaves a value out.
const DEFAULT_SECONDS_STILL = 0;
const DEFAULT_POSITION_CHANGED = false;
const DEFAULT_MODEL_CONFIDENCE = 1;
// Upper bound when reading a device's family members.
const MAX_FAMILY_MEMBERS = 50;
// /ack searches this many recent incidents for the receipt (arrays cannot be indexed).
const ACK_SEARCH_LIMIT = 100;
// Shown when the Pushover user key does not match anyone in the family.
const UNKNOWN_ACKNOWLEDGER = "Someone";

// Called by POST /fall (convex/http.ts). Bad input never throws: it returns
// { ok: false } so the route can answer 404 instead of 500.
export const recordFall = internalMutation({
  args: {
    deviceId: v.string(),
    round: v.union(v.literal(1), v.literal(2)),
    impactMaxG: v.number(),
    secondsStill: v.optional(v.number()),
    positionChanged: v.optional(v.boolean()),
    modelConfidence: v.optional(v.number()),
    // Raw string from the query string; validated here with normalizeId.
    incidentId: v.optional(v.string()),
    audioId: v.optional(v.id("_storage")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), incidentId: v.id("incidents") }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) return { ok: false as const, error: "Unknown device" };

    let incidentId: Id<"incidents">;
    if (args.round === 2 && args.incidentId !== undefined) {
      // Round 2: update the same incident. Status is left alone.
      const id = ctx.db.normalizeId("incidents", args.incidentId);
      const incident = id ? await ctx.db.get("incidents", id) : null;
      if (!id || !incident || incident.deviceId !== args.deviceId) {
        return { ok: false as const, error: "Unknown incident" };
      }
      await ctx.db.patch("incidents", id, {
        round: 2,
        impact_max_g: args.impactMaxG,
        ...(args.secondsStill !== undefined && { seconds_still: args.secondsStill }),
        ...(args.positionChanged !== undefined && {
          position_changed: args.positionChanged,
        }),
        ...(args.modelConfidence !== undefined && {
          model_confidence: args.modelConfidence,
        }),
        ...(args.audioId !== undefined && {
          audioIds: [...incident.audioIds, args.audioId],
        }),
      });
      incidentId = id;
    } else {
      // Round 1, or round 2 without incidentId (the watch lost the round-1 reply).
      incidentId = await ctx.db.insert("incidents", {
        deviceId: args.deviceId,
        status: "asking",
        round: args.round,
        impact_max_g: args.impactMaxG,
        seconds_still: args.secondsStill ?? DEFAULT_SECONDS_STILL,
        position_changed: args.positionChanged ?? DEFAULT_POSITION_CHANGED,
        model_confidence: args.modelConfidence ?? DEFAULT_MODEL_CONFIDENCE,
        audioIds: args.audioId !== undefined ? [args.audioId] : [],
        receipts: [],
        createdAt: Date.now(),
      });
      // Alert the family right away, in the same transaction as the write.
      // CJ-13 replaces this direct call with the AI step. Round 2 does not alert
      // again until CJ-16.
      if (args.round === 1) {
        await ctx.scheduler.runAfter(0, internal.notify.sendAlert, {
          incidentId,
          level: "emergency",
          message: `Possible fall. Impact of ${args.impactMaxG.toFixed(1)} g`,
        });
      }
    }

    return { ok: true as const, incidentId };
  },
});

const statusValidator = v.union(
  v.literal("asking"),
  v.literal("precautionary"),
  v.literal("emergency"),
  v.literal("closed"),
  v.literal("acknowledged"),
);
const levelValidator = v.union(v.literal("precautionary"), v.literal("emergency"));

// Everything sendAlert (convex/notify.ts) needs, in one read. null if the incident is gone.
export const getAlertTargets = internalQuery({
  args: { incidentId: v.id("incidents") },
  returns: v.union(
    v.null(),
    v.object({
      deviceId: v.string(),
      status: statusValidator,
      createdAt: v.number(),
      personName: v.string(),
      members: v.array(v.object({ name: v.string(), pushoverUserKey: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident) return null;
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .unique();
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    return {
      deviceId: incident.deviceId,
      status: incident.status,
      createdAt: incident.createdAt,
      personName: device?.personName ?? incident.deviceId,
      members: members.map((m) => ({ name: m.name, pushoverUserKey: m.pushoverUserKey })),
    };
  },
});

// Called by sendAlert after the Pushover requests. Applies the no-downgrade rule
// again, because the status may have changed while the requests were in flight.
export const saveReceipts = internalMutation({
  args: {
    incidentId: v.id("incidents"),
    level: levelValidator,
    receipts: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident) return null;

    const finished = incident.status === "acknowledged" || incident.status === "closed";
    const downgrade = args.level === "precautionary" && incident.status === "emergency";
    await ctx.db.patch("incidents", incident._id, {
      receipts: [...incident.receipts, ...args.receipts],
      ...(!finished && !downgrade && { status: args.level }),
    });

    // Someone acknowledged while these were being sent: stop them from repeating.
    if (finished && args.receipts.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notify.cancelReceipts, {
        receipts: args.receipts,
      });
    }
    return null;
  },
});

// Called by POST /ack when a family member acknowledges an emergency in Pushover.
// Idempotent: Pushover may call the callback more than once.
export const acknowledge = internalMutation({
  args: { receipt: v.string(), userKey: v.optional(v.string()) },
  returns: v.union(
    v.object({ found: v.literal(false) }),
    v.object({ found: v.literal(true), alreadyAcknowledged: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const recent = await ctx.db.query("incidents").order("desc").take(ACK_SEARCH_LIMIT);
    const incident = recent.find((i) => i.receipts.includes(args.receipt));
    if (!incident) return { found: false as const };
    if (incident.status === "acknowledged") {
      return { found: true as const, alreadyAcknowledged: true };
    }

    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const name =
      members.find((m) => args.userKey !== undefined && m.pushoverUserKey === args.userKey)
        ?.name ?? UNKNOWN_ACKNOWLEDGER;

    await ctx.db.patch("incidents", incident._id, {
      status: "acknowledged",
      acknowledgedBy: name,
    });
    // For the watch to say (GET /poll, CJ-14). Audio is added by a later task.
    await ctx.db.insert("messages", {
      deviceId: incident.deviceId,
      incidentId: incident._id,
      text: `${name} is on the way`,
      askAgain: false,
      delivered: false,
    });
    // Stop the alerts still repeating on the other family members' phones.
    if (incident.receipts.length > 0) {
      await ctx.scheduler.runAfter(0, internal.notify.cancelReceipts, {
        receipts: incident.receipts,
      });
    }
    return { found: true as const, alreadyAcknowledged: false };
  },
});
