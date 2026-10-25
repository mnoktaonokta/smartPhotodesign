// Sliding-divider before/after video. Left of the divider shows Before, right
// shows After; the split is the divider's horizontal position (0..1).

export const VIDEO_FPS = 30;
export const VIDEO_DURATIONS = { short: 6, normal: 8, long: 10 };

// [time in seconds for the 8 s timeline, split]. Holds are repeated splits.
const KEYFRAMES = [
  [0, 1],
  [1.2, 1],
  [2.4, 0.3],
  [2.8, 0.3],
  [3.8, 0.7],
  [4.6, 0.45],
  [5.0, 0.45],
  [6.2, 0],
  [8, 0],
];
const BASE_DURATION = KEYFRAMES.at(-1)[0];
const CODECS = ["avc1.640028", "avc1.4d0028"];
const BITRATE = 12_000_000;

function easeInOut(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Divider position at ``t`` seconds of a video lasting ``duration`` seconds. */
export function splitAt(t, duration = BASE_DURATION) {
  const u = (t / duration) * BASE_DURATION;
  if (u <= 0) return KEYFRAMES[0][1];
  for (let i = 1; i < KEYFRAMES.length; i++) {
    const [t1, s1] = KEYFRAMES[i];
    if (u <= t1) {
      const [t0, s0] = KEYFRAMES[i - 1];
      return s0 + (s1 - s0) * easeInOut((u - t0) / (t1 - t0));
    }
  }
  return KEYFRAMES.at(-1)[1];
}

export async function supportedCodec(width, height) {
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of CODECS) {
    const config = { codec, width, height, bitrate: BITRATE, framerate: VIDEO_FPS, avc: { format: "avc" } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // Try the next profile.
    }
  }
  return null;
}

/**
 * Encode the sliding video to an MP4 blob.
 * ``sheet`` holds the Before frame on top of the After frame, each ``width`` x ``height``.
 * ``box`` is the photo area [x0, y0, x1, y1]; the divider travels only across it.
 */
export async function encodeSliderVideo({ sheet, width, height, box = [0, 0, width, height], duration, onProgress }) {
  const config = await supportedCodec(width, height);
  if (!config) {
    throw new Error("Bu tarayıcı MP4 video üretemiyor. Chrome, Edge veya Safari'nin güncel sürümünü kullanın.");
  }
  const { Muxer, ArrayBufferTarget } = await import("../vendor/mp4-muxer.mjs");
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height, frameRate: VIDEO_FPS },
    fastStart: "in-memory",
  });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => (failure = error),
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frames = Math.round(duration * VIDEO_FPS);
  const frameDuration = 1e6 / VIDEO_FPS;
  for (let i = 0; i < frames; i++) {
    if (failure) break;
    drawFrame(ctx, sheet, width, height, box, splitAt(i / VIDEO_FPS, duration));
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameDuration), duration: Math.round(frameDuration) });
    encoder.encode(frame, { keyFrame: i % (VIDEO_FPS * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    if (i % 15 === 0) onProgress?.(i / frames);
  }
  await encoder.flush().catch((error) => (failure ??= error));
  encoder.close();
  if (failure) throw new Error(`Video kodlanamadı: ${failure.message || failure}`);
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

function drawFrame(ctx, sheet, width, height, box, split) {
  const [x0, y0, x1, y1] = box;
  const x = Math.round(x0 + (x1 - x0) * split);
  ctx.drawImage(sheet, 0, height, width, height, 0, 0, width, height);
  if (x > 0) ctx.drawImage(sheet, 0, 0, x, height, 0, 0, x, height);
  // Fade the divider out at the edges so the first and last frames are clean photos.
  const visibility = Math.min(1, Math.min(split, 1 - split) / 0.04);
  if (visibility <= 0) return;
  drawDivider(ctx, x, width, y0, y1, visibility);
}

function drawDivider(ctx, x, width, top, bottom, alpha) {
  const line = Math.max(3, Math.round(width * 0.004));
  const radius = Math.round(width * 0.035);
  const cy = (top + bottom) / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = radius * 0.4;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - line / 2, top, line, bottom - top);
  ctx.beginPath();
  ctx.arc(x, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#2a2a2a";
  const a = radius * 0.32;
  const gap = radius * 0.18;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + dir * (gap + a), cy);
    ctx.lineTo(x + dir * gap, cy - a);
    ctx.lineTo(x + dir * gap, cy + a);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
