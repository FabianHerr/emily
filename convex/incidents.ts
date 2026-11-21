import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { notRespondingMessage } from "./decide";
import { logEvent } from "./events";

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
// A /fall that arrives this soon after an open incident on the same watch is a
// retry (the watch lost our reply), not a new fall: reuse the incident, no new alert.
const DEDUPE_WINDOW_MS = 60_000;
// Last defence (HANDOFF.md section 8): a new incident with no decision, or whose round 2
// never came, gets an emergency after this long. The watch waits up to 20 s for our
// round-1 reply before asking round 2 on its own, so round 2 can arrive 30+ s after
// round 1; processFall normally decides in under 10 s.
const LAST_DEFENCE_MS = 60_000;

// This round's clip, or null. Older rows only have the legacy audioIds array.
function roundAudioId(incident: Doc<"incidents">, round: 1 | 2): Id<"_storage"> | null {
  const own = round === 1 ? incident.round1AudioId : incident.round2AudioId;
  return own ?? incident.audioIds?.[round - 1] ?? null;
}

// The patch that stores a clip in its round's own field.
function audioPatch(
  round: 1 | 2,
  audioId: Id<"_storage">,
): { round1AudioId: Id<"_storage"> } | { round2AudioId: Id<"_storage"> } {
  return round === 1 ? { round1AudioId: audioId } : { round2AudioId: audioId };
}

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
    v.object({
      ok: v.literal(true),
      incidentId: v.id("incidents"),
      // True when the uploaded audio was a duplicate and was not attached.
      audioUnused: v.optional(v.boolean()),
    }),
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
      // Already round 2 means this is a retry (the watch lost our reply): the clip is
      // not attached twice and nothing is processed again.
      const isRetry = incident.round === 2;
      const attachAudio =
        args.audioId !== undefined && !isRetry && roundAudioId(incident, 2) === null;
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
        ...(attachAudio && audioPatch(2, args.audioId!)),
      });
      // Process the second answer (or second silence).
      if (!isRetry) {
        await ctx.scheduler.runAfter(0, internal.ai.processFall, { incidentId: id, round: 2 });
      }
      const audioUnused = args.audioId !== undefined && !attachAudio;
      return { ok: true as const, incidentId: id, audioUnused };
    } else {
      // Round 1, or round 2 without incidentId (the watch lost the round-1 reply).
      const latest = await ctx.db
        .query("incidents")
        .withIndex("by_deviceId_and_createdAt", (q) => q.eq("deviceId", args.deviceId))
        .order("desc")
        .first();
      const isOpen =
        latest !== null &&
        (latest.status === "asking" ||
          latest.status === "precautionary" ||
          latest.status === "emergency");
      if (latest !== null && isOpen && Date.now() - latest.createdAt < DEDUPE_WINDOW_MS) {
        // Retry of a fall we already have: same incident, no new alert from the retry itself.
        // One clip per round, in that round's own field: a retried upload is not attached twice.
        const attachAudio =
          args.audioId !== undefined && roundAudioId(latest, args.round) === null;
        const roundAdvanced = args.round === 2 && latest.round !== 2;
        await ctx.db.patch("incidents", latest._id, {
          ...(roundAdvanced && { round: 2 }),
          ...(attachAudio && audioPatch(args.round, args.audioId!)),
        });
        // Something new (round 2, or a clip we did not have): decide again. A pure
        // retry that changed nothing schedules nothing.
        if (roundAdvanced || attachAudio) {
          await ctx.scheduler.runAfter(0, internal.ai.processFall, {
            incidentId: latest._id,
            round: args.round,
          });
        }
        const audioUnused = args.audioId !== undefined && !attachAudio;
        return { ok: true as const, incidentId: latest._id, audioUnused };
      }
      incidentId = await ctx.db.insert("incidents", {
        deviceId: args.deviceId,
        status: "asking",
        round: args.round,
        impact_max_g: args.impactMaxG,
        seconds_still: args.secondsStill ?? DEFAULT_SECONDS_STILL,
        position_changed: args.positionChanged ?? DEFAULT_POSITION_CHANGED,
        model_confidence: args.modelConfidence ?? DEFAULT_MODEL_CONFIDENCE,
        // A round 2 without incidentId keeps its clip as round 2's, not round 1's.
        ...(args.audioId !== undefined && audioPatch(args.round, args.audioId)),
        receipts: [],
        createdAt: Date.now(),
      });
      await logEvent(ctx, {
        deviceId: args.deviceId,
        incidentId,
        type: "fall_detected",
        text: `Fall detected (impact ${args.impactMaxG.toFixed(1)} g)`,
        level: "info",
      });
      // Hand the new incident to the AI Service, in the same transaction as the write.
      // It transcribes, decides and alerts; no clip counts as silence. A round 2
      // without incidentId means round 1 never reached us.
      await ctx.scheduler.runAfter(0, internal.ai.processFall, {
        incidentId,
        round: args.round,
      });
      // Convex does not retry scheduled actions: if processFall dies outside its
      // try/catch, this is what still alerts the family. It checks itself and does
      // nothing once the incident has a decision or has moved on.
      await ctx.scheduler.runAfter(LAST_DEFENCE_MS, internal.incidents.lastDefence, {
        incidentId,
      });
    }

    return { ok: true as const, incidentId };
  },
});

// Scheduled by recordFall for every new incident. Sends an EMERGENCY if, 60 s later,
// the incident is still "asking" and either no decision was ever saved (processFall
// died) or round 1 asked again and round 2 never came (the watch lost WiFi or crashed).
// Never cancelled: it checks itself and does nothing once round 2 arrived, or the
// incident was closed, acknowledged or alerted (status is no longer "asking").
export const lastDefence = internalMutation({
  args: { incidentId: v.id("incidents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident || incident.status !== "asking") return null;
    const noDecision = incident.decision === undefined;
    const roundTwoMissing = incident.round === 1 && incident.decision?.ask_again === true;
    if (!noDecision && !roundTwoMissing) return null;
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .unique();
    console.error(
      `lastDefence: ${noDecision ? "no decision" : "no round 2"} for ${incident._id} after ${LAST_DEFENCE_MS} ms, sending an emergency`,
    );
    await ctx.scheduler.runAfter(0, internal.notify.sendAlert, {
      incidentId: incident._id,
      level: "emergency",
      message: notRespondingMessage(device?.personName ?? incident.deviceId),
    });
    return null;
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
        incidentId: incident._id,
        receipts: args.receipts,
      });
    }
    return null;
  },
});

// The AI's decision (convex/decide.ts Decision), as a Convex validator.
export const decisionValidator = v.object({
  notify: v.boolean(),
  level: v.union(v.literal("none"), v.literal("precautionary"), v.literal("emergency")),
  severity: v.string(),
  confidence: v.number(),
  family_summary: v.string(),
  reply_to_person: v.union(v.string(), v.null()),
  ask_again: v.boolean(),
});
// What is stored in incidents.decision: the decision plus how it was made.
const storedDecisionValidator = decisionValidator.extend({
  source: v.union(
    v.literal("silence"),
    v.literal("claude"),
    v.literal("gemini"),
    v.literal("rules"),
  ),
  sttMs: v.number(),
  aiMs: v.union(v.number(), v.null()),
});

// Everything processFall (convex/ai.ts) needs, in one read. Family NAMES only, never
// their Pushover keys. audioId is this round's clip, or null when the round has none.
export const getFallContext = internalQuery({
  args: { incidentId: v.id("incidents"), round: v.union(v.literal(1), v.literal(2)) },
  returns: v.union(
    v.null(),
    v.object({
      deviceId: v.string(),
      status: statusValidator,
      impactMaxG: v.number(),
      secondsStill: v.number(),
      positionChanged: v.boolean(),
      personName: v.string(),
      familyNames: v.array(v.string()),
      audioId: v.union(v.id("_storage"), v.null()),
      // An emergency already went out (or was decided) for this incident.
      emergencySent: v.boolean(),
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
      impactMaxG: incident.impact_max_g,
      secondsStill: incident.seconds_still,
      positionChanged: incident.position_changed,
      personName: device?.personName ?? incident.deviceId,
      familyNames: members.map((m) => m.name),
      // This round's own clip: a late round 1 must not transcribe the round-2 clip,
      // and round 2 must find its clip even when round 1 had none.
      audioId: roundAudioId(incident, args.round),
      emergencySent:
        incident.status === "emergency" || incident.decision?.level === "emergency",
    };
  },
});

// Called by processFall once the decision is made. Level "none" closes the incident
// only when it is final: not when the watch will ask again (a closed incident would
// silence round 2's emergency), not when a newer round already arrived (a late round 1
// must not close it under round 2), and never one that is already an emergency or
// acknowledged (the repeating alerts could no longer be stopped from /ack).
export const saveDecision = internalMutation({
  args: {
    incidentId: v.id("incidents"),
    round: v.union(v.literal(1), v.literal(2)),
    transcript: v.union(v.string(), v.null()),
    decision: storedDecisionValidator,
  },
  // False when a newer round already arrived: the caller must not speak this stale reply.
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const incident = await ctx.db.get("incidents", args.incidentId);
    if (!incident) return false;
    // A late round 1 must not overwrite round 2's decision either.
    if (incident.round > args.round) return false;
    const isFinalNone = args.decision.level === "none" && !args.decision.ask_again;
    const canClose = incident.status === "asking" || incident.status === "precautionary";
    const closes = isFinalNone && canClose;
    await ctx.db.patch("incidents", incident._id, {
      transcript: args.transcript,
      decision: args.decision,
      ...(closes && { status: "closed" as const }),
    });

    // Activity feed: only what the person said, never the AI's interpretation.
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .unique();
    const personName = device?.personName ?? incident.deviceId;
    const level = args.decision.level === "none" ? "info" : args.decision.level;
    await logEvent(ctx, {
      deviceId: incident.deviceId,
      incidentId: incident._id,
      ...(args.transcript !== null
        ? { type: "person_said", text: `${personName} said: "${args.transcript}"` }
        : { type: "no_answer", text: `${personName} did not answer (round ${args.round})` }),
      level,
    });
    if (closes) {
      // "precautionary" means an alert already went out.
      const outcome = incident.status === "asking" ? "No alert sent." : "Incident closed.";
      await logEvent(ctx, {
        deviceId: incident.deviceId,
        incidentId: incident._id,
        type: "incident_closed",
        text: `${personName} said they are OK. ${outcome}`,
        level: "info",
      });
    }
    return true;
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
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", incident.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    const name =
      members.find((m) => args.userKey !== undefined && m.pushoverUserKey === args.userKey)
        ?.name ?? UNKNOWN_ACKNOWLEDGER;

    const { alreadyHandled } = await acknowledgeIncident(ctx, incident, name);
    return { found: true as const, alreadyAcknowledged: alreadyHandled };
  },
});

// Shared by POST /ack (acknowledge above) and the portal's "On my way" (portal.onMyWay).
// An incident already acknowledged, or closed as a false alarm, is left alone: a late
// tap must not reopen it. Otherwise: mark it acknowledged, log it, tell the watch, and
// stop the alerts still repeating on the other family members' phones.
export async function acknowledgeIncident(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  name: string,
): Promise<{ alreadyHandled: boolean }> {
  if (incident.status === "acknowledged" || incident.status === "closed") {
    return { alreadyHandled: true };
  }
  await ctx.db.patch("incidents", incident._id, {
    status: "acknowledged",
    acknowledgedBy: name,
  });
  await logEvent(ctx, {
    deviceId: incident.deviceId,
    incidentId: incident._id,
    type: "acknowledged",
    text: `${name} is on the way`,
    level: "info",
  });
  // For the watch to say (Talk to Loved One adds the audio; GET /poll delivers it).
  await ctx.scheduler.runAfter(0, internal.talk.say, {
    deviceId: incident.deviceId,
    incidentId: incident._id,
    text: `${name} is on the way`,
    askAgain: false,
  });
  await ctx.scheduler.runAfter(0, internal.notify.cancelReceipts, {
    incidentId: incident._id,
    receipts: incident.receipts,
  });
  return { alreadyHandled: false };
}

// The portal's "False alarm" button (portal.markFalseAlarm). Closes the incident from
// any open or acknowledged status, stops the repeating alerts and tells the watch.
// Already closed: nothing to do.
export async function markIncidentFalseAlarm(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  name: string,
): Promise<void> {
  if (incident.status === "closed") return;
  await ctx.db.patch("incidents", incident._id, { status: "closed", falseAlarmBy: name });
  await logEvent(ctx, {
    deviceId: incident.deviceId,
    incidentId: incident._id,
    type: "incident_closed",
    text: `${name} marked this as a false alarm`,
    level: "info",
  });
  await ctx.scheduler.runAfter(0, internal.notify.cancelReceipts, {
    incidentId: incident._id,
    receipts: incident.receipts,
  });
  await ctx.scheduler.runAfter(0, internal.talk.say, {
    deviceId: incident.deviceId,
    incidentId: incident._id,
    text: "It was a false alarm. Everything is OK.",
    askAgain: false,
  });
}
