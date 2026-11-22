// Heartbeat and no-signal detection (CJ-24, backend half). The watch proves it is alive
// with POST /heartbeat or GET /poll; a per-minute cron (convex/crons.ts) logs when it goes
// quiet. Pushover for these is switched off by SIGNAL_ALERTS_ENABLED in convex/notify.ts.

import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { logEvent } from "./events";
import { torontoClock } from "./time";

// The watch polls every 60 s, so 3 minutes of silence means it is off, out of WiFi or
// crashed. Same value as the portal's "No signal" headline (src/App.tsx).
const NO_SIGNAL_AFTER_MS = 3 * 60 * 1000;
// "Low battery" is logged once below LOW, and can only be logged again after the battery
// went back above RECOVERED, so a battery hovering around 15% does not repeat it.
const LOW_BATTERY_PERCENT = 15;
const BATTERY_RECOVERED_PERCENT = 20;
// Upper bound on the watches checked each minute.
const MAX_DEVICES = 100;
// Upper bound when reading a device's family members.
const MAX_FAMILY_MEMBERS = 50;

// Shared by POST /heartbeat (battery may be given) and GET /poll (no battery).
// Saves the heartbeat and logs the state changes: back online, low battery.
export async function recordHeartbeat(
  ctx: MutationCtx,
  device: Doc<"devices">,
  battery: number | undefined,
): Promise<void> {
  const patch: Partial<Pick<Doc<"devices">, "lastHeartbeat" | "battery" | "noSignalAlerted" | "lowBatteryAlerted">> = {
    lastHeartbeat: Date.now(),
  };
  if (device.noSignalAlerted) {
    patch.noSignalAlerted = false;
    const text = `${device.personName}'s watch is back online`;
    await logEvent(ctx, { deviceId: device.deviceId, type: "watch_online", text, level: "info" });
    await ctx.scheduler.runAfter(0, internal.notify.sendSignalAlert, {
      deviceId: device.deviceId,
      kind: "online",
      text,
    });
  }
  if (battery !== undefined) {
    patch.battery = battery;
    if (battery < LOW_BATTERY_PERCENT && !device.lowBatteryAlerted) {
      patch.lowBatteryAlerted = true;
      // Floor: 14.6% is below 15 and must not read "15%".
      const text = `Low battery (${Math.floor(battery)}%)`;
      await logEvent(ctx, { deviceId: device.deviceId, type: "low_battery", text, level: "info" });
      await ctx.scheduler.runAfter(0, internal.notify.sendSignalAlert, {
        deviceId: device.deviceId,
        kind: "low_battery",
        text,
      });
    } else if (battery > BATTERY_RECOVERED_PERCENT && device.lowBatteryAlerted) {
      patch.lowBatteryAlerted = false;
    }
  }
  await ctx.db.patch("devices", device._id, patch);
}

// Called by POST /heartbeat. A battery outside 0-100 is ignored; the heartbeat still counts.
export const heartbeat = internalMutation({
  args: { deviceId: v.string(), battery: v.optional(v.number()) },
  returns: v.object({ known: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (!device) return { known: false };
    const battery =
      args.battery !== undefined && args.battery >= 0 && args.battery <= 100
        ? args.battery
        : undefined;
    await recordHeartbeat(ctx, device, battery);
    return { known: true };
  },
});

// Every minute (convex/crons.ts). Logs "no signal" once per outage; the next heartbeat
// or poll clears it (recordHeartbeat). Watches that never sent a heartbeat are skipped:
// they are not set up yet, so there is nothing to miss.
export const checkSignal = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const devices = await ctx.db.query("devices").take(MAX_DEVICES);
    for (const device of devices) {
      if (device.lastHeartbeat === undefined || device.noSignalAlerted) continue;
      if (now - device.lastHeartbeat <= NO_SIGNAL_AFTER_MS) continue;
      await ctx.db.patch("devices", device._id, { noSignalAlerted: true });
      const text = `${device.personName}'s watch has not responded since ${torontoClock(device.lastHeartbeat)}`;
      await logEvent(ctx, {
        deviceId: device.deviceId,
        type: "watch_offline",
        text,
        level: "precautionary",
      });
      await ctx.scheduler.runAfter(0, internal.notify.sendSignalAlert, {
        deviceId: device.deviceId,
        kind: "offline",
        text,
      });
    }
    return null;
  },
});

// Who to tell, for notify.sendSignalAlert. Keys stay in the backend.
export const getSignalTargets = internalQuery({
  args: { deviceId: v.string() },
  returns: v.array(v.object({ name: v.string(), pushoverUserKey: v.string() })),
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("familyMembers")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .take(MAX_FAMILY_MEMBERS);
    return members.map((m) => ({ name: m.name, pushoverUserKey: m.pushoverUserKey }));
  },
});
