import { spawn } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const INPUT = 'heart.mp4';
const COLS = 105;
const ROWS = 75;
const FPS = 24;

const RAMP = ' .:-=+*#%@';
const CROP = 'crop=800:1000:558:40';

// Global contrast boost baked into the encode — replicates a "max contrast"
// editor pass: pushes greys toward black/white while keeping a thin detail band.
const CONTRAST = 1.6;

const cellW = 8;
const cellH = 14;
const videoW = COLS * cellW;
const videoH = ROWS * cellH;

function lumaToChar(luma) {
  const inverted = 255 - luma;
  // Contrast-stretch + gamma: spread mp4 midtones toward the extremes so the
  // ramp uses its full range instead of clustering on faint glyphs.
  const BLACK = 25, WHITE = 195, GAMMA = 0.9;
  const norm = Math.min(1, Math.max(0, (inverted - BLACK) / (WHITE - BLACK)));
  const stretched = 255 * Math.pow(norm, GAMMA);
  if (stretched < 18) return ' ';
  const idx = Math.floor((stretched / 255) * (RAMP.length - 1));
  return RAMP[idx];
}

const charBrightness = {};
for (let i = 0; i < RAMP.length; i++) {
  charBrightness[RAMP[i]] = Math.floor((i / (RAMP.length - 1)) * 255);
}

// Extract frames
const extractArgs = [
  '-i', INPUT,
  '-vf', `${CROP},scale=${COLS}:${ROWS}:flags=lanczos,format=gray`,
  '-f', 'rawvideo', '-pix_fmt', 'gray',
  '-r', String(FPS), '-v', 'quiet', '-'
];

const extract = spawn('ffmpeg', extractArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
const chunks = [];
extract.stdout.on('data', (chunk) => chunks.push(chunk));

extract.on('close', (code) => {
  if (code !== 0) { console.error('ffmpeg extract failed'); process.exit(1); }

  const raw = Buffer.concat(chunks);
  const frameSize = COLS * ROWS;
  const frameCount = Math.floor(raw.length / frameSize);
  console.log(`Extracted ${frameCount} frames (${COLS}x${ROWS} @ ${FPS}fps)`);

  const trimEnd = 2;
  const asciiFrames = [];
  for (let f = 0; f < frameCount - trimEnd; f++) {
    const offset = f * frameSize;
    const lines = [];
    for (let r = 0; r < ROWS; r++) {
      let line = '';
      for (let c = 0; c < COLS; c++) {
        line += lumaToChar(raw[offset + r * COLS + c]);
      }
      lines.push(line);
    }
    asciiFrames.push(lines.join('\n'));
  }

  asciiFrames.reverse();

  // Two independent axes per variant:
  //   FLOOR — tonal gradient (low = more grey separation between features)
  //   pad   — ink coverage / heaviness (low = bigger, heavier marks)
  // Light needs heavier marks (less padding) to feel weighty on white, plus a
  // lower floor so a real grey gradient separates detail instead of fusing.
  // Backgrounds stay pure white / pure black so the page's mix-blend-mode
  // (multiply / screen) makes the video edge seamless.
  const FLOOR_LIGHT = 0.55;
  const FLOOR_DARK = 0.5;
  const variants = [
    { output: 'heart_ascii_light.mp4', bg: [255, 255, 255], padX: 2, padY: 3, fgFn: (t) => { const v = Math.round(255 * (1 - (FLOOR_LIGHT + (1 - FLOOR_LIGHT) * t))); return [v, v, v]; } },
    { output: 'heart_ascii_dark.mp4', bg: [0, 0, 0], padX: 2, padY: 3, fgFn: (t) => { const v = Math.round(228 * (FLOOR_DARK + (1 - FLOOR_DARK) * t)); return [v, v, v]; } },
  ];

  const usedFrameCount = asciiFrames.length;
  let done = 0;
  for (const variant of variants) {
    encodeVariant(asciiFrames, usedFrameCount, variant, () => {
      done++;
      if (done === variants.length) {
        console.log('Both variants complete.');
      }
    });
  }
});

function encodeVariant(asciiFrames, frameCount, { output, bg, fgFn, padX, padY }, cb) {
  const encodeArgs = [
    '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', `${videoW}x${videoH}`,
    '-framerate', String(FPS), '-i', '-',
    '-vf', `eq=contrast=${CONTRAST},colorspace=all=bt709:iall=bt601-6-625:fast=1`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-color_range', 'pc',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output
  ];

  const encode = spawn('ffmpeg', encodeArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  let framesWritten = 0;
  function writeNextFrame() {
    if (framesWritten >= frameCount) {
      encode.stdin.end();
      return;
    }

    const frameBuffer = Buffer.alloc(videoW * videoH * 3);
    // Fill background
    for (let i = 0; i < videoW * videoH; i++) {
      frameBuffer[i * 3] = bg[0];
      frameBuffer[i * 3 + 1] = bg[1];
      frameBuffer[i * 3 + 2] = bg[2];
    }

    const lines = asciiFrames[framesWritten].split('\n');
    for (let r = 0; r < lines.length; r++) {
      const line = lines[r];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === ' ') continue;
        const brightness = charBrightness[ch] || 0;
        if (brightness === 0) continue;

        const t = brightness / 255;
        const [rv, gv, bv] = fgFn(t);

        const startX = c * cellW;
        const startY = r * cellH;
        for (let py = startY + padY; py < startY + cellH - padY && py < videoH; py++) {
          for (let px = startX + padX; px < startX + cellW - padX && px < videoW; px++) {
            const idx = (py * videoW + px) * 3;
            frameBuffer[idx] = rv;
            frameBuffer[idx + 1] = gv;
            frameBuffer[idx + 2] = bv;
          }
        }
      }
    }

    const ok = encode.stdin.write(frameBuffer);
    framesWritten++;
    if (framesWritten % 50 === 0) console.log(`  ${output}: ${framesWritten}/${frameCount}`);

    if (ok) {
      writeNextFrame();
    } else {
      encode.stdin.once('drain', writeNextFrame);
    }
  }

  writeNextFrame();
  encode.on('close', (code) => {
    if (code === 0) {
      console.log(`Done: ${output}`);
    } else {
      console.error(`Failed: ${output}`);
    }
    cb();
  });
}
