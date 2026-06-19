// Regenerate favicon.png from the rendered ASCII heart MP4.
//
// Earlier versions re-derived glyphs from heart.mp4 and drew them as circular
// dots — which did NOT match the site asset (heart_ascii_light.mp4 draws solid
// rectangular cells). To stay pixel-faithful we now pull a frame straight out
// of the rendered MP4, find the heart's ink bounding box, crop a centered
// square (white padding), and scale to the favicon size.

import { spawn } from 'child_process';

const INPUT = 'heart_ascii_light.mp4';
const FRAME = Number(process.argv[2] ?? 0);   // 0 = full front-facing heart
const OUT = process.argv[3] ?? 'favicon.png';
const SIZE = 512;
const MARGIN = 18;          // white border around the heart, in source px
const WHITE_CUTOFF = 245;   // pixels brighter than this count as background

// Decode the chosen frame to raw RGB so we can measure the ink bounding box.
const probe = spawn('ffmpeg', [
  '-i', INPUT,
  '-vf', `select=eq(n\\,${FRAME})`,
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-v', 'quiet', '-'
], { stdio: ['ignore', 'pipe', 'inherit'] });

const chunks = [];
probe.stdout.on('data', (c) => chunks.push(c));
probe.on('close', () => {
  const raw = Buffer.concat(chunks);
  // The MP4 is 700x900 (see convert-to-ascii.mjs). Derive from buffer length.
  const W = 700, H = 900;
  if (raw.length !== W * H * 3) {
    console.error(`unexpected frame size: ${raw.length} bytes (expected ${W * H * 3})`);
    process.exit(1);
  }

  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const lum = (raw[i] + raw[i + 1] + raw[i + 2]) / 3;
      if (lum < WHITE_CUTOFF) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  minX -= MARGIN; minY -= MARGIN; maxX += MARGIN; maxY += MARGIN;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.max(bw, bh);
  // Center the square crop over the heart's bbox.
  let cropX = Math.round((minX + maxX) / 2 - side / 2);
  let cropY = Math.round((minY + maxY) / 2 - side / 2);

  // ffmpeg crop clamps to frame bounds; if the square spills past the edge we
  // pad with white first so the heart stays centered instead of shifting.
  const padL = Math.max(0, -cropX);
  const padT = Math.max(0, -cropY);
  const padR = Math.max(0, cropX + side - W);
  const padB = Math.max(0, cropY + side - H);
  const padW = W + padL + padR;
  const padH = H + padT + padB;

  const vf = [
    `select=eq(n\\,${FRAME})`,
    `pad=${padW}:${padH}:${padL}:${padT}:white`,
    `crop=${side}:${side}:${cropX + padL}:${cropY + padT}`,
    `scale=${SIZE}:${SIZE}:flags=lanczos`,
  ].join(',');

  const enc = spawn('ffmpeg', [
    '-y', '-i', INPUT, '-vf', vf, '-frames:v', '1', '-update', '1', OUT, '-v', 'error'
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  enc.on('close', (code) => {
    console.log(code === 0
      ? `Wrote ${OUT} (frame ${FRAME}, ${SIZE}x${SIZE}, crop ${side}x${side} @ ${cropX},${cropY})`
      : 'encode failed');
  });
});
