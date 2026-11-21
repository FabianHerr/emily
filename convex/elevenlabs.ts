"use node";
// Node runtime: the ElevenLabs SDK imports Node built-ins (node:events,
// node:crypto, node:http) and does not bundle in Convex's default runtime.
// This file must contain only actions.

import { v } from "convex/values";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// Speech to text (HANDOFF.md section 8: give up at 4 s, continue with transcript null).
const STT_TIMEOUT_MS = 4000;
const STT_MODEL_ID = "scribe_v2";
const STT_LANGUAGE_CODE = "en";
// The API has no silence flag: fewer letters than this counts as silence.
const MIN_TRANSCRIPT_LETTERS = 3;

// Text to speech (HANDOFF.md section 8: on timeout the watch shows text instead).
// v4 turbo measured 0.9-1.1 s warm (flash: 0.4 s, but a flatter voice). 5 s leaves
// room for a cold first call (flash took 3.2 s cold).
const TTS_TIMEOUT_MS = 5000;
const TTS_MODEL_ID = "eleven_v4_turbo";
const TTS_OUTPUT_FORMAT = "wav_16000";

// Audio contract (HANDOFF.md section 6): 16-bit PCM, 16 kHz, mono.
const WAV_SAMPLE_RATE = 16000;
const WAV_CHANNELS = 1;
const WAV_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

function makeClient(): ElevenLabsClient | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  // No SDK retries: a retry would blow the hard timeout.
  return new ElevenLabsClient({ apiKey, maxRetries: 0 });
}

// Runs `fn` with an AbortSignal and rejects after `ms`, aborting the request.
async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function countLetters(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

type Bytes = Uint8Array<ArrayBuffer>;

function startsWithRiff(bytes: Bytes): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  );
}

// Wraps raw 16 kHz mono 16-bit PCM in a 44-byte WAV header.
function addWavHeader(pcm: Bytes): Bytes {
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);
  const byteRate = (WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8;
  const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8;
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

export const transcribe = internalAction({
  args: { audioId: v.id("_storage") },
  returns: v.object({
    transcript: v.union(v.string(), v.null()),
    ms: v.number(),
  }),
  handler: async (ctx, args) => {
    const start = Date.now();
    try {
      const client = makeClient();
      if (!client) throw new Error("ELEVENLABS_API_KEY is not set");
      const audio = await ctx.storage.get(args.audioId);
      if (!audio) throw new Error(`Audio ${args.audioId} not found in storage`);

      const result = await withTimeout(STT_TIMEOUT_MS, (abortSignal) =>
        client.speechToText.convert(
          {
            file: { data: audio, filename: "audio.wav", contentType: "audio/wav" },
            modelId: STT_MODEL_ID,
            languageCode: STT_LANGUAGE_CODE,
          },
          { abortSignal, maxRetries: 0 },
        ),
      );

      const text = (result.text ?? "").trim();
      const transcript = countLetters(text) < MIN_TRANSCRIPT_LETTERS ? null : text;
      return { transcript, ms: Date.now() - start };
    } catch (error) {
      console.error("elevenlabs.transcribe failed:", error);
      return { transcript: null, ms: Date.now() - start };
    }
  },
});

export const speak = internalAction({
  args: { text: v.string() },
  returns: v.object({
    audioId: v.union(v.id("_storage"), v.null()),
    ms: v.number(),
  }),
  handler: async (ctx, args) => {
    const start = Date.now();
    try {
      const client = makeClient();
      if (!client) throw new Error("ELEVENLABS_API_KEY is not set");
      const voiceId = process.env.ELEVENLABS_VOICE_ID;
      if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not set");

      const bytes = await withTimeout<Bytes>(TTS_TIMEOUT_MS, async (abortSignal) => {
        const stream = await client.textToSpeech.convert(
          voiceId,
          {
            text: args.text,
            modelId: TTS_MODEL_ID,
            outputFormat: TTS_OUTPUT_FORMAT,
          },
          { abortSignal, maxRetries: 0 },
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      });

      const wav = startsWithRiff(bytes) ? bytes : addWavHeader(bytes);
      const audioId: Id<"_storage"> = await ctx.storage.store(
        new Blob([wav], { type: "audio/wav" }),
      );
      return { audioId, ms: Date.now() - start };
    } catch (error) {
      console.error("elevenlabs.speak failed:", error);
      return { audioId: null, ms: Date.now() - start };
    }
  },
});
