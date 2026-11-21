// Service: Notify Family. Alerts the family through Pushover and handles "On my way".
// Default runtime (no "use node"): plain fetch works here. Actions only; the
// database side lives in convex/incidents.ts.

import { v } from "convex/values";
import { env, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const PUSHOVER_MESSAGES_URL = "https://api.pushover.net/1/messages.json";
const PUSHOVER_RECEIPTS_URL = "https://api.pushover.net/1/receipts";
// Each Pushover request gives up after this, so one slow request never blocks the rest.
const REQUEST_TIMEOUT_MS = 5000;
// Scheduled actions are not retried by Convex, so a failed send is retried here.
// Pushover asks for at least 5 s between retries, and never retrying a 4xx.
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

// Priorities (HANDOFF.md section 9).
const PRECAUTIONARY_PRIORITY = 1; // sounds once
const EMERGENCY_PRIORITY = 2; // repeats until someone acknowledges
// Pushover requires retry >= 30 and expire <= 10800 (seconds).
const EMERGENCY_RETRY_SECONDS = 30;
const EMERGENCY_EXPIRE_SECONDS = 3600;

// Pushover limits (HANDOFF.md section 12).
const MAX_TITLE_CHARS = 250;
const MAX_MESSAGE_CHARS = 1024;

const ALERT_TIME_ZONE = "America/Toronto";

type Level = "precautionary" | "emergency";
type Status = "asking" | "precautionary" | "emergency" | "closed" | "acknowledged";
type AlertTargets = {
  deviceId: string;
  status: Status;
  createdAt: number;
  personName: string;
  members: { name: string; pushoverUserKey: string }[];
} | null;

// No duplicate, no downgrade: an emergency is never followed by a precautionary,
// and nothing is sent once someone acknowledged or the incident is closed.
export function shouldSkipAlert(status: Status, level: Level): boolean {
  if (status === "acknowledged" || status === "closed") return true;
  return level === "precautionary" && status === "emergency";
}

// Cuts by code points so an emoji is never split in half.
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

// "Rosa fell at 2:14 PM" in Toronto time. Checked in the Convex runtime: Intl
// with timeZone handles EST and EDT correctly.
export function alertTitle(personName: string, createdAt: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ALERT_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(new Date(createdAt));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${part("hour")}:${part("minute")} ${part("dayPeriod")}`;
  return truncate(`${personName} fell at ${time}`, MAX_TITLE_CHARS);
}

// Pushover refused the request (4xx: bad key, bad parameter). Retrying cannot help.
class PushoverRejected extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tag put on every emergency message of an incident, so all of them can be
// cancelled at once even if a receipt was never saved (e.g. our request timed out
// after Pushover had accepted it).
function incidentTag(incidentId: string): string {
  return `incident-${incidentId}`;
}

// POSTs a form to Pushover and returns the parsed JSON. Throws on timeout,
// on a non-2xx answer, or when Pushover says status != 1.
async function postToPushover(
  url: string,
  fields: Record<string, string>,
): Promise<{ receipt?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      status?: unknown;
      errors?: unknown;
      receipt?: unknown;
    } | null;
    if (!res.ok || body?.status !== 1) {
      // Only Pushover's error text: never the token or the user key.
      const detail = `HTTP ${res.status}: ${JSON.stringify(body?.errors ?? null)}`;
      if (res.status >= 400 && res.status < 500) throw new PushoverRejected(detail);
      throw new Error(detail);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const sendAlert = internalAction({
  args: {
    incidentId: v.id("incidents"),
    level: v.union(v.literal("precautionary"), v.literal("emergency")),
    message: v.string(),
  },
  returns: v.object({ sent: v.number(), failed: v.number() }),
  // Explicit types: incidents.ts and this file reference each other.
  handler: async (ctx, args): Promise<{ sent: number; failed: number }> => {
    const nothing = { sent: 0, failed: 0 };

    const targets: AlertTargets = await ctx.runQuery(internal.incidents.getAlertTargets, {
      incidentId: args.incidentId,
    });
    if (!targets) {
      console.error(`sendAlert: unknown incident ${args.incidentId}`);
      return nothing;
    }
    if (shouldSkipAlert(targets.status, args.level)) {
      console.log(`sendAlert: skipped ${args.level}, incident is ${targets.status}`);
      return nothing;
    }
    const token = process.env.PUSHOVER_APP_TOKEN;
    if (!token) {
      console.error("sendAlert: PUSHOVER_APP_TOKEN is not set");
      return nothing;
    }
    if (targets.members.length === 0) {
      console.error(`sendAlert: no family members for device ${targets.deviceId}`);
      return nothing;
    }

    const common: Record<string, string> = {
      token,
      title: alertTitle(targets.personName, targets.createdAt),
      message: truncate(args.message, MAX_MESSAGE_CHARS),
    };
    if (args.level === "emergency") {
      common.priority = String(EMERGENCY_PRIORITY);
      common.retry = String(EMERGENCY_RETRY_SECONDS);
      common.expire = String(EMERGENCY_EXPIRE_SECONDS);
      common.callback = `${env.CONVEX_SITE_URL}/ack`;
      common.tags = incidentTag(args.incidentId);
    } else {
      common.priority = String(PRECAUTIONARY_PRIORITY);
    }

    // One family member: send, retry if Pushover is down or slow, and save the
    // receipt the moment it arrives, so an acknowledgment that comes seconds later
    // already finds it. Returns true when the alert was delivered to Pushover.
    const sendToMember = async (member: { name: string; pushoverUserKey: string }) => {
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
          const body = await postToPushover(PUSHOVER_MESSAGES_URL, {
            ...common,
            user: member.pushoverUserKey,
          });
          // Also sets the incident status: it only changes once an alert really went out.
          await ctx.runMutation(internal.incidents.saveReceipts, {
            incidentId: args.incidentId,
            level: args.level,
            receipts: typeof body.receipt === "string" ? [body.receipt] : [],
          });
          return true;
        } catch (error) {
          console.error(
            `sendAlert: ${args.level} to ${member.name}, attempt ${attempt} failed: ${String(error)}`,
          );
          if (error instanceof PushoverRejected) return false;
          if (attempt < MAX_SEND_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
      }
      return false;
    };

    // In parallel and independent: one bad key or slow request never blocks the rest.
    const results = await Promise.all(targets.members.map(sendToMember));
    const sent = results.filter(Boolean).length;
    if (sent === 0) console.error(`sendAlert: NOBODY was alerted for ${args.incidentId}`);
    return { sent, failed: results.length - sent };
  },
});

// Stops the repeating emergency alerts once someone said "On my way". Never throws.
export const cancelReceipts = internalAction({
  args: { incidentId: v.optional(v.id("incidents")), receipts: v.array(v.string()) },
  returns: v.object({ cancelled: v.number(), failed: v.number() }),
  handler: async (_ctx, args) => {
    const token = process.env.PUSHOVER_APP_TOKEN;
    if (!token) {
      console.error("cancelReceipts: PUSHOVER_APP_TOKEN is not set");
      return { cancelled: 0, failed: args.receipts.length };
    }
    // By tag first: stops every emergency message of the incident, including any
    // whose receipt we never saved.
    if (args.incidentId !== undefined) {
      try {
        await postToPushover(
          `${PUSHOVER_RECEIPTS_URL}/cancel_by_tag/${encodeURIComponent(incidentTag(args.incidentId))}.json`,
          { token },
        );
      } catch (error) {
        console.error(`cancelReceipts: cancel by tag failed: ${String(error)}`);
      }
    }
    const results = await Promise.allSettled(
      args.receipts.map((receipt) =>
        postToPushover(
          `${PUSHOVER_RECEIPTS_URL}/${encodeURIComponent(receipt)}/cancel.json`,
          { token },
        ),
      ),
    );
    let failed = 0;
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failed++;
        console.error(
          `cancelReceipts: ${args.receipts[i]} failed: ${String(result.reason)}`,
        );
      }
    });
    return { cancelled: results.length - failed, failed };
  },
});
