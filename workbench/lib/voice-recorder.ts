"use client";

/**
 * Browser-side helpers for capturing microphone audio and turning it into a
 * 24 kHz mono 16-bit PCM WAV blob — the format Gradium STT expects when
 * `input_format` is "wav".
 *
 * Usage:
 *   const rec = await startRecording();
 *   // ...later
 *   const wav = await rec.stop();         // Blob, audio/wav
 *   const fd  = await fetch("/api/stt", { method: "POST", body: wav });
 *   const { text } = await fd.json();
 */

const TARGET_SAMPLE_RATE = 24_000;

export type Recorder = {
  stop: () => Promise<Blob>;
  cancel: () => void;
};

export async function startRecording(): Promise<Recorder> {
  if (typeof window === "undefined") throw new Error("Recorder is browser-only");
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Pick a mime type the browser supports for MediaRecorder.
  const mime =
    ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(
      (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
    ) || "";

  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mr.start();

  let cancelled = false;
  const releaseTracks = () => stream.getTracks().forEach((t) => t.stop());

  return {
    cancel() {
      cancelled = true;
      try {
        mr.stop();
      } catch {
        /* noop */
      }
      releaseTracks();
    },
    stop(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        mr.onstop = async () => {
          releaseTracks();
          if (cancelled) {
            reject(new Error("recording cancelled"));
            return;
          }
          try {
            const recordedBlob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
            const wav = await blobToWav24k(recordedBlob);
            resolve(wav);
          } catch (err) {
            reject(err);
          }
        };
        mr.stop();
      });
    },
  };
}

async function blobToWav24k(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer();
  // Decode at the device's native rate first.
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtx();
  const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
  decodeCtx.close();

  // Resample to 24 kHz mono via OfflineAudioContext.
  const lengthAtTarget = Math.ceil((decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, lengthAtTarget, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  // Mix down to mono by routing through a gain node that sums channels.
  if (decoded.numberOfChannels > 1) {
    const merger = offline.createChannelMerger(1);
    const splitter = offline.createChannelSplitter(decoded.numberOfChannels);
    src.connect(splitter);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      splitter.connect(merger, ch, 0);
    }
    merger.connect(offline.destination);
  } else {
    src.connect(offline.destination);
  }
  src.start(0);
  const rendered = await offline.startRendering();

  const float = rendered.getChannelData(0);
  return encodeWav16(float, TARGET_SAMPLE_RATE);
}

function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples (clamped + scaled)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
