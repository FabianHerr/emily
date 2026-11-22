// Service: Talk to Loved One. Turns what Emily says into audio and queues it for the
// watch (GET /poll and GET /audio/<id> in convex/http.ts).
// Default runtime: text to speech lives in convex/elevenlabs.ts (Node), called with runAction.

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { logEvent } from "./events";
import { recordHeartbeat } from "./signal";

// Scheduled (never awaited) by the AI Service and by /ack, so the family alert never
// waits for the audio. If the voice fails or times out, the message is queued with
// text only and the watch shows it on screen. No incidentId for messages that are not
// about a fall (pill reminders).
export const say = internalAction({
  args: {
    deviceId: v.string(),
    incidentId: v.optional(v.id("incidents")),
    text: v.string(),
    askAgain: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    let audioId: Id<"_storage"> | null = null;
    let ttsMs: number | null = null;
    // "Ask again" with no reply has nothing to say: the watch repeats its own question.
    if (args.text.trim() !== "") {
      try {
        const voice: { audioId: Id<"_storage"> | null; ms: number } = await ctx.runAction(
          internal.elevenlabs.speak,
          { text: args.text },
        );
        audioId = voice.audioId;
        ttsMs = voice.ms;
      } catch (error) {
        console.error(`talk.say: voice failed, queueing text only: ${String(error)}`);
      }
    }
    await ctx.runMutation(internal.talk.queueMessage, {
      deviceId: args.deviceId,
      ...(args.incidentId !== undefined && { incidentId: args.incidentId }),
      text: args.text,
      askAgain: args.askAgain,
      ...(audioId !== null && { audioId }),
    });
    console.log(`talk.say: queued, audio ${audioId !== null ? "yes" : "no"}, tts ${ttsMs ?? "-"} ms`);
    return null;
  },
});

export const queueMessage = internalMutation({
  args: {
    deviceId: v.string(),
    incidentId: v.optional(v.id("incidents")),
    text: v.string(),
    askAgain: v.boolean(),
    audioId: v.optional(v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", { ...args, delivered: false });
    return null;
  },
});

// Called by GET /poll. Returns the oldest undelivered message and marks it delivered.
// Also counts as a heartbeat. { known: false } when the device does not exist.
export const poll = internalMutation({
  args: { deviceId: v.string() },
  returns: v.union(
    v.object({ known: v.literal(false) }),
    v.object({
      known: v.literal(true),
      message: v.union(
        v.null(),
        v.object({
          text: v.string(),
          askAgain: v.boolean(),
          audioId: v.union(v.id("_storage"), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) return { known: false as const };
    // Same as POST /heartbeat without a battery: also clears a "no signal" flag.
    await recordHeartbeat(ctx, device, undefined);

    // Oldest first: within one index value, rows come back in creation order.
    const next = await ctx.db
      .query("messages")
      .withIndex("by_deviceId_and_delivered", (q) =>
        q.eq("deviceId", args.deviceId).eq("delivered", false),
      )
      .first();
    if (!next) return { known: true as const, message: null };
    await ctx.db.patch("messages", next._id, { delivered: true });
    // An "ask again" with no text says nothing new: not worth a feed row.
    if (next.text.trim() !== "") {
      await logEvent(ctx, {
        deviceId: args.deviceId,
        incidentId: next.incidentId,
        type: "watch_said",
        text: `Watch told ${device.personName}: "${next.text}"`,
        level: "info",
      });
    }
    return {
      known: true as const,
      message: { text: next.text, askAgain: next.askAgain, audioId: next.audioId ?? null },
    };
  },
});
