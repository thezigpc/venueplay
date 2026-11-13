// Raw audio as the box plays it: 16-bit little-endian stereo at 44.1 kHz. Every source is
// decoded to this, and every output takes it, so volume and pause work the same everywhere.

import { Readable } from "node:stream";

export const RATE = 44_100;
export const CHANNELS = 2;
/** Bytes per second of PCM (S16LE stereo). */
export const BYTES_PER_SEC = RATE * CHANNELS * 2;

/** The venue's 0-100 volume as a gain (squared, so the slider feels even to the ear). */
export function gainFor(volume: number): number {
  const v = Math.max(0, Math.min(100, volume)) / 100;
  return v * v;
}

/** Scales S16LE samples in place by `gain` (0-1). `buf` must hold whole samples. */
export function applyGain(buf: Buffer, gain: number): Buffer {
  if (gain >= 0.999) return buf;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(buf.readInt16LE(i * 2) * gain), i * 2);
  return buf;
}

/** Splits a stream of chunks into whole 16-bit samples, carrying an odd byte to the next chunk. */
export class SampleAligner {
  private carry: Buffer | undefined;
  push(chunk: Buffer): Buffer {
    const data = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = data.length & ~1;
    this.carry = whole < data.length ? data.subarray(whole) : undefined;
    // A copy: gain is applied in place and the source may reuse its buffers.
    return Buffer.from(data.subarray(0, whole));
  }
}

/** A WAV header for an endless stream (AirPlay's decoder wants a container, not raw PCM). */
export function wavHeader(): Buffer {
  const h = Buffer.alloc(44);
  const big = 0xffffffff - 36;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(big + 36, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(CHANNELS * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(big, 40);
  return h;
}

/** A test tone: a soft two-note chime, `seconds` long, with fades so it doesn't click. */
export function toneStream(seconds = 2.5): Readable {
  const total = Math.round(seconds * RATE);
  const fade = Math.round(0.05 * RATE);
  let i = 0;
  return new Readable({
    read() {
      if (i >= total) return void this.push(null);
      const frames = Math.min(4410, total - i);
      const buf = Buffer.alloc(frames * 4);
      for (let f = 0; f < frames; f++, i++) {
        const half = i < total / 2;
        const freq = half ? 660 : 880;
        const local = half ? i : i - Math.floor(total / 2);
        const len = half ? Math.floor(total / 2) : total - Math.floor(total / 2);
        const env = Math.min(1, local / fade, (len - local) / fade);
        const s = Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * 0.3 * env * 32767);
        buf.writeInt16LE(s, f * 4);
        buf.writeInt16LE(s, f * 4 + 2);
      }
      this.push(buf);
    },
  });
}

/** 100 ms of silence: what an output gets while a session is paused. */
export const SILENCE = Buffer.alloc(BYTES_PER_SEC / 10);
