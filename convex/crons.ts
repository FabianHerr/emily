// Every-minute jobs: pill reminders (CJ-25) and the watch signal check (CJ-24).

import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { logEvent } from "./events";
import { torontoDay, torontoHHMM } from "./time";

// Pills due in one minute, across every watch: far above the 20 per watch the portal allows.
const MAX_DUE_PILLS = 200;
// The cron can start late in its minute (seen 49 s in), so each run also covers the
// minute before: a run that slips past the boundary still says the pill, once.
const MINUTES_COVERED = [1, 0]; // minutes ago, oldest first

// Finds the pills due this Toronto minute (or the one before) that were not announced
// that day, marks them, logs them and queues the reminder for the watch (it arrives
// through the normal /poll).
export const remindPills = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const due: { pill: Doc<"pills">; day: string }[] = [];
    for (const minutesAgo of MINUTES_COVERED) {
      const at = now - minutesAgo * 60_000;
      // That minute's own day: at 00:00 the 23:59 pill belongs to yesterday.
      const day = torontoDay(at);
      const pills = await ctx.db
        .query("pills")
        .withIndex("by_time", (q) => q.eq("time", torontoHHMM(at)))
        .take(MAX_DUE_PILLS);
      for (const pill of pills) due.push({ pill, day });
    }
    const devices = new Map<string, Doc<"devices"> | null>();
    for (const { pill, day } of due) {
      // Already said that day: the run after, or a retry, says nothing new.
      if (pill.lastAnnouncedDay === day) continue;
      let device = devices.get(pill.deviceId);
      if (device === undefined) {
        device = await ctx.db
          .query("devices")
          .withIndex("by_deviceId", (q) => q.eq("deviceId", pill.deviceId))
          .unique();
        devices.set(pill.deviceId, device);
      }
      if (!device) continue;
      await ctx.db.patch("pills", pill._id, { lastAnnouncedDay: day });
      await logEvent(ctx, {
        deviceId: pill.deviceId,
        type: "pill_reminder",
        text: `Reminded ${device.personName}: ${pill.name} pill`,
        level: "info",
      });
      // Scheduled, not awaited: Talk to Loved One makes the audio on its own time.
      await ctx.scheduler.runAfter(0, internal.talk.say, {
        deviceId: pill.deviceId,
        text: `${device.personName}, it's time for your ${pill.name} pill.`,
        askAgain: false,
      });
    }
    return null;
  },
});

const crons = cronJobs();
// On the minute (not a 60 s interval, which drifts): pill times are whole minutes.
crons.cron("pill reminders", "* * * * *", internal.crons.remindPills, {});
// Logs "no signal" once a watch has been quiet for 3 minutes (convex/signal.ts).
crons.cron("watch signal check", "* * * * *", internal.signal.checkSignal, {});
// Keeps the Node actions (speech to text, Emily's voice) from going to sleep (convex/elevenlabs.ts).
crons.interval("keep voice functions awake", { minutes: 1 }, internal.elevenlabs.keepAwake, {});
export default crons;
