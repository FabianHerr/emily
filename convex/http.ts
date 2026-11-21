import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// A 5 s, 16 kHz, mono, 16-bit WAV is ~160 KB. Anything bigger is a bug.
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const AUDIO_CONTENT_TYPE = "audio/wav";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class BadRequest extends Error {}

// Returns undefined when the parameter is missing or empty; throws BadRequest when it is not a number.
function optionalNumber(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadRequest(`'${name}' must be a number`);
  return n;
}

// POST /fall?device=watch-1&round=1&impact=3.4&still=8&position=1&confidence=0.91[&incidentId=...]
// Body: raw WAV bytes (may be empty). Contract: HANDOFF.md section 6.
const fall = httpAction(async (ctx, req) => {
  const params = new URL(req.url).searchParams;

  let deviceId: string;
  let round: 1 | 2;
  let impactMaxG: number;
  let secondsStill: number | undefined;
  let positionChanged: boolean | undefined;
  let modelConfidence: number | undefined;
  try {
    deviceId = (params.get("device") ?? "").trim();
    if (!deviceId) throw new BadRequest("'device' is required");

    const roundRaw = params.get("round");
    if (roundRaw !== "1" && roundRaw !== "2") throw new BadRequest("'round' must be 1 or 2");
    round = roundRaw === "1" ? 1 : 2;

    const impact = optionalNumber(params, "impact");
    if (impact === undefined) throw new BadRequest("'impact' is required");
    impactMaxG = impact;

    secondsStill = optionalNumber(params, "still");
    if (secondsStill !== undefined && secondsStill < 0) {
      throw new BadRequest("'still' must be 0 or more");
    }

    const position = params.get("position");
    if (position !== null && position !== "" && position !== "0" && position !== "1") {
      throw new BadRequest("'position' must be 0 or 1");
    }
    positionChanged = position === "1" ? true : position === "0" ? false : undefined;

    modelConfidence = optionalNumber(params, "confidence");
    if (modelConfidence !== undefined && (modelConfidence < 0 || modelConfidence > 1)) {
      throw new BadRequest("'confidence' must be between 0 and 1");
    }
  } catch (error) {
    if (error instanceof BadRequest) return json(400, { error: error.message });
    throw error;
  }
  const incidentId = params.get("incidentId")?.trim() || undefined;

  // Size guard: check the header first so a huge upload is not read at all.
  const declaredLength = Number(req.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) {
    return json(400, { error: `Audio is larger than ${MAX_AUDIO_BYTES} bytes` });
  }
  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json(400, { error: `Audio is larger than ${MAX_AUDIO_BYTES} bytes` });
  }

  let audioId: Id<"_storage"> | undefined;
  if (audio.byteLength > 0) {
    audioId = await ctx.storage.store(new Blob([audio], { type: AUDIO_CONTENT_TYPE }));
  }

  const result = await ctx.runMutation(internal.incidents.recordFall, {
    deviceId,
    round,
    impactMaxG,
    secondsStill,
    positionChanged,
    modelConfidence,
    incidentId,
    audioId,
  });

  if (!result.ok) {
    // Do not keep audio that no incident points to.
    if (audioId) await ctx.storage.delete(audioId);
    return json(404, { error: result.error });
  }
  return json(200, { incidentId: result.incidentId });
});

// Pushover's callback body is tiny; ignore anything bigger.
const MAX_ACK_BODY_CHARS = 16 * 1024;
const MAX_RECEIPT_CHARS = 100;

// Reads one string field from a form-encoded body, a JSON body, or the query string.
function readAckField(
  form: URLSearchParams,
  jsonBody: unknown,
  query: URLSearchParams,
  name: string,
): string | undefined {
  const fromJson =
    typeof jsonBody === "object" && jsonBody !== null
      ? (jsonBody as Record<string, unknown>)[name]
      : undefined;
  const raw =
    form.get(name) ?? (typeof fromJson === "string" ? fromJson : null) ?? query.get(name);
  const value = raw?.trim();
  return value ? value : undefined;
}

// POST /ack: Pushover calls this when a family member acknowledges an emergency.
// Fields: receipt, acknowledged, acknowledged_at, acknowledged_by (user key),
// acknowledged_by_device. Always answers 200: anything else makes Pushover retry.
const ack = httpAction(async (ctx, req) => {
  try {
    const text = await req.text().catch(() => "");
    const body = text.length <= MAX_ACK_BODY_CHARS ? text : "";
    let jsonBody: unknown = null;
    try {
      jsonBody = JSON.parse(body);
    } catch {
      // Not JSON: form-encoded or empty.
    }
    const form = new URLSearchParams(body);
    const query = new URL(req.url).searchParams;

    const receipt = readAckField(form, jsonBody, query, "receipt");
    if (!receipt || receipt.length > MAX_RECEIPT_CHARS) {
      return json(200, { ok: true, found: false });
    }
    const userKey = readAckField(form, jsonBody, query, "acknowledged_by");
    const result = await ctx.runMutation(internal.incidents.acknowledge, { receipt, userKey });
    return json(200, { ok: true, found: result.found });
  } catch (error) {
    console.error(`/ack failed: ${String(error)}`);
    return json(200, { ok: false });
  }
});

const http = httpRouter();
http.route({ path: "/fall", method: "POST", handler: fall });
http.route({ path: "/ack", method: "POST", handler: ack });
export default http;
