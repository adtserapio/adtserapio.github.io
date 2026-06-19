import { spawn } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const INPUT = 'heart.mp4';
// Grid sized so the encoded video is exactly 700px wide = 2x the 350px CSS
// display width. On retina (2x DPR) that's a 1:1 map (no resample); on 1x
// screens it's a clean 2:1 downscale. Both avoid the fractional-resample
// moiré, so we can afford a finer grid (more detail) than the 60x43 we used
// to hide the moiré.
const COLS = 70;
const ROWS = 63;  // 700x882 keeps the source's 0.8 portrait aspect (crop 800x1000)
const FPS = 24;

const RAMP = ' .:-=+*#%@';
const CROP = 'crop=800:1000:558:40';

// Global contrast boost baked into the encode — replicates a "max contrast"
// editor pass: pushes greys toward black/white while keeping a thin detail band.
const CONTRAST = 1.6;

// Slight blur (in final display pixels) softens the hard dot-grid so its
// periodic on/off pattern can't beat against the screen pixel grid — this is
// what kills moiré across arbitrary zoom/DPR levels, which no encode size can.
const BLUR = 0.8;

const cellW = 10;  // 70 cols * 10 = 700px wide = 2x the 350px CSS display
const cellH = 14;
// Display resolution of the encoded video.
const videoW = COLS * cellW;
const videoH = ROWS * cellH;

// Supersampling: render the raw frame SS× larger, then downscale with lanczos
// in the encode. This anti-aliases the hard glyph-rectangle edges (which
// otherwise alias/shimmer and get mangled by H.264).
const SS = 3;
const ssCellW = cellW * SS;
const ssCellH = cellH * SS;
const ssW = videoW * SS;
const ssH = videoH * SS;

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
    '-video_size', `${ssW}x${ssH}`,
    '-framerate', String(FPS), '-i', '-',
    // Downscale the supersampled frame with lanczos (anti-aliases glyph edges),
    // then apply contrast + colorspace at display resolution.
    '-vf', `scale=${videoW}:${videoH}:flags=lanczos,gblur=sigma=${BLUR},eq=contrast=${CONTRAST},colorspace=all=bt709:iall=bt601-6-625:fast=1`,
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

    const frameBuffer = Buffer.alloc(ssW * ssH * 3);
    // Fill background
    for (let i = 0; i < ssW * ssH; i++) {
      frameBuffer[i * 3] = bg[0];
      frameBuffer[i * 3 + 1] = bg[1];
      frameBuffer[i * 3 + 2] = bg[2];
    }

    // Padding scaled to the supersampled grid.
    const ssPadX = padX * SS;
    const ssPadY = padY * SS;

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

        const startX = c * ssCellW;
        const startY = r * ssCellH;
        for (let py = startY + ssPadY; py < startY + ssCellH - ssPadY && py < ssH; py++) {
          for (let px = startX + ssPadX; px < startX + ssCellW - ssPadX && px < ssW; px++) {
            const idx = (py * ssW + px) * 3;
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
