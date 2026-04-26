import { NextRequest, NextResponse } from "next/server";
import WebSocket from "ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRADIUM_URL = "wss://api.gradium.ai/api/speech/asr";
const CHUNK_MS = 80; // recommended by Gradium (1920 samples @ 24 kHz)

/**
 * POST /api/stt
 *
 * Body: raw bytes of a WAV file (Content-Type: audio/wav).
 * The client is expected to send 24 kHz mono 16-bit PCM in a WAV container,
 * but Gradium accepts any 16/24/32-bit PCM WAV with input_format="wav".
 *
 * Returns: { text: string } — the joined transcript.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.GRADIUM_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GRADIUM_API_KEY is not configured on the server." },
      { status: 500 },
    );
  }

  const audio = Buffer.from(await req.arrayBuffer());
  if (audio.length === 0) {
    return NextResponse.json({ error: "Empty audio body." }, { status: 400 });
  }

  try {
    const text = await transcribe(audio, apiKey);
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function transcribe(wavBytes: Buffer, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GRADIUM_URL, {
      headers: { "x-api-key": apiKey },
      handshakeTimeout: 10_000,
    });

    const segments: string[] = [];
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve(segments.join(" ").replace(/\s+/g, " ").trim());
    };

    const overall = setTimeout(() => finish(new Error("STT timeout")), 30_000);

    ws.on("open", () => {
      // 1. setup — must be first
      ws.send(
        JSON.stringify({
          type: "setup",
          model_name: "default",
          input_format: "wav",
        }),
      );

      // The 'wav' format wants the whole file delivered. Chunk it for streaming
      // friendliness — Gradium tolerates it because the WAV header carries the
      // length and the server reassembles the byte stream.
      const CHUNK_BYTES = 24_000 * 2 * (CHUNK_MS / 1000); // 24 kHz * 16-bit * 80 ms
      let offset = 0;
      const sendNext = () => {
        if (offset >= wavBytes.length) {
          ws.send(JSON.stringify({ type: "end_of_stream" }));
          return;
        }
        const slice = wavBytes.subarray(offset, offset + CHUNK_BYTES);
        offset += slice.length;
        ws.send(
          JSON.stringify({ type: "audio", audio: slice.toString("base64") }),
        );
        // Yield to event loop so messages aren't coalesced
        setImmediate(sendNext);
      };
      sendNext();
    });

    ws.on("message", (raw) => {
      let msg: { type?: string; text?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "text":
          if (msg.text) segments.push(msg.text);
          break;
        case "end_of_stream":
          clearTimeout(overall);
          finish();
          break;
        case "error":
          clearTimeout(overall);
          finish(new Error(msg.message || "Gradium STT error"));
          break;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(overall);
      finish(err as Error);
    });

    ws.on("close", () => {
      clearTimeout(overall);
      finish();
    });
  });
}
