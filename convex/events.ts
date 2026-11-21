// Activity feed for the family portal (CJ-28). Every step of the system leaves one
// row with ready-to-show English text; the portal only reads this table.

import { v, type Infer } from "convex/values";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// events.list returns this many rows when the caller gives no limit, and never more than the max.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const eventFields = schema.tables.events.validator.fields;
type EventType = Infer<typeof eventFields.type>;
type EventLevel = Infer<typeof eventFields.level>;

export type EventInput = {
  deviceId: string;
  incidentId?: Id<"incidents">;
  type: EventType;
  text: string;
  level: EventLevel;
};

// The only write path. Never throws: a failed log must never roll back or block an alert.
export async function logEvent(ctx: MutationCtx, event: EventInput): Promise<void> {
  try {
    await ctx.db.insert("events", { ...event, createdAt: Date.now() });
  } catch (error) {
    console.error(`logEvent: could not log ${event.type}: ${String(error)}`);
  }
}

// For actions, which have no ctx.db (e.g. notify.sendAlert).
export const log = internalMutation({
  args: {
    deviceId: eventFields.deviceId,
    incidentId: eventFields.incidentId,
    type: eventFields.type,
    text: eventFields.text,
    level: eventFields.level,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await logEvent(ctx, args);
    return null;
  },
});

// "Fabian", "Fabian and Sebastian", "Ana, Fabian and Sebastian".
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Public, no auth (demo). Newest first.
export const list = query({
  args: { deviceId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(schema.doc("events")),
  handler: async (ctx, args) => {
    const requested =
      args.limit !== undefined && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIST_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
    return await ctx.db
      .query("events")
      .withIndex("by_deviceId_and_createdAt", (q) => q.eq("deviceId", args.deviceId))
      .order("desc")
      .take(limit);
  },
});
