import { spawn } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const INPUT = 'heart.mp4';
const COLS = 70;
const ROWS = 50;
const FPS = 24;

const RAMP = ' .:-=+*#%@';
const CROP = 'crop=800:1000:558:40';

const cellW = 8;
const cellH = 14;
const videoW = COLS * cellW;
const videoH = ROWS * cellH;

function lumaToChar(luma) {
  const inverted = 255 - luma;
  if (inverted < 35) return ' ';
  const idx = Math.floor((inverted / 255) * (RAMP.length - 1));
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

  const asciiFrames = [];
  for (let f = 0; f < frameCount; f++) {
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

  // Encode both variants
  const variants = [
    { output: 'heart_ascii_light.mp4', bg: [255, 255, 255], fgFn: (t) => [Math.round(255 * (1 - t)), Math.round(255 * (1 - t)), Math.round(255 * (1 - t))] },
    { output: 'heart_ascii_dark.mp4', bg: [0, 0, 0], fgFn: (t) => [Math.round(228 * t), Math.round(228 * t), Math.round(228 * t)] },
  ];

  let done = 0;
  for (const variant of variants) {
    encodeVariant(asciiFrames, frameCount, variant, () => {
      done++;
      if (done === variants.length) {
        console.log('Both variants complete.');
      }
    });
  }
});

function encodeVariant(asciiFrames, frameCount, { output, bg, fgFn }, cb) {
  const encodeArgs = [
    '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', `${videoW}x${videoH}`,
    '-framerate', String(FPS), '-i', '-',
    '-vf', 'colorspace=all=bt709:iall=bt601-6-625:fast=1',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-color_range', 'pc',
    '-pix_fmt', 'yuv420p', '-an', output
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
        const padX = 2;
        const padY = 3;
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
