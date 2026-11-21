import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Defaults for POST /fall when the watch leaves a value out.
const DEFAULT_SECONDS_STILL = 0;
const DEFAULT_POSITION_CHANGED = false;
const DEFAULT_MODEL_CONFIDENCE = 1;

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
    }

    // TODO(CJ-13): schedule the AI step here, in the same transaction as the write:
    // await ctx.scheduler.runAfter(0, internal.<module>.<aiStep>, { incidentId });

    return { ok: true as const, incidentId };
  },
});
