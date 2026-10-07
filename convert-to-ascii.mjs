import { spawn } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const INPUT = 'heart.mp4';
// Grid sized so the encoded video is exactly 700px wide = 2x the 350px CSS
// display width. On retina (2x DPR) that's a 1:1 map (no resample); on 1x
// screens it's a clean 2:1 downscale. Both avoid the fractional-resample
// moiré, so we can afford a finer grid (more detail) than the 60x43 we used
// to hide the moiré.
const COLS = 110;
const ROWS = 100;  // many, small cells = smaller circles, higher detail
const FPS = 24;

const RAMP = ' .:-=+*#%@';
const CROP = 'crop=800:1000:558:40';

// The coronary arteries are blue/purple veins on red tissue. Standard luma
// weights blue at only ~11%, so they vanish into the body — which is why the
// arteries had disappeared. This mix over-weights blue (and flattens R/G) so
// the vessels keep contrast against the heart when we collapse to gray.
const VESSEL_MIX = 'colorchannelmixer=' +
  'rr=0.25:rg=0.25:rb=0.9:' +
  'gr=0.25:gg=0.25:gb=0.9:' +
  'br=0.25:bg=0.25:bb=0.9';

// Global contrast boost baked into the encode — replicates a "max contrast"
// editor pass: pushes greys toward black/white while keeping a thin detail band.
const CONTRAST = 1.6;

// Slight blur (in final display pixels) softens the hard dot-grid so its
// periodic on/off pattern can't beat against the screen pixel grid — this is
// what kills moiré across arbitrary zoom/DPR levels, which no encode size can.
const BLUR = 0.8;

// CSS display width now scales up to 620px on large screens (see
// .ascii-video-wrap video in index.html); size the encode so it still
// covers ~2x that at retina density without upscaling blur.
const cellW = 12; // 100 cols * 12 = 1200px wide ~= 2x the 620px max CSS display
const cellH = 18; // 90 rows * 18 = 1620px, ~matches the 800x1000 crop aspect
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
  '-vf', `${CROP},${VESSEL_MIX},scale=${COLS}:${ROWS}:flags=lanczos,format=gray`,
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
  const FLOOR_LIGHT = 0.75;
  const FLOOR_DARK = 0.7;

  // Diagonal black -> gold sweep: glyph hue is purely positional (top-left to
  // bottom-right), independent of brightness, so it reads as a reflection
  // sweeping across the heart rather than tonal shading. Brightness t still
  // controls how far each glyph sits between background and its position's
  // fully-saturated color, so density/edges still read.
  function lerp(a, b, p) { return a + (b - a) * p; }
  function lerpColor(c1, c2, p) {
    return [
      Math.round(lerp(c1[0], c2[0], p)),
      Math.round(lerp(c1[1], c2[1], p)),
      Math.round(lerp(c1[2], c2[2], p)),
    ];
  }

  const LIGHT_BLACK_HIGH = [10, 10, 10];     // near-black ink
  const LIGHT_GOLD_HIGH = [158, 112, 8];     // darker, deeply saturated gold for contrast on white

  const DARK_BLACK_HIGH = [60, 52, 30];      // dark bronze, softer against black bg
  const DARK_GOLD_HIGH = [255, 196, 60];     // bright gold, pops against black

  function makeFgFn(bg, lowColorA, highColorA, lowColorB, highColorB, floor) {
    return (t, c, r) => {
      const posT = (c / COLS + r / ROWS) / 2; // 0 (top-left) -> 1 (bottom-right)
      const low = lerpColor(lowColorA, lowColorB, posT);
      const high = lerpColor(highColorA, highColorB, posT);
      const p = floor + (1 - floor) * t;
      return lerpColor(low, high, p);
    };
  }

  const variants = [
    { output: 'heart_ascii_light.mp4', bg: [255, 255, 255], fgFn: makeFgFn([255, 255, 255], [255, 255, 255], LIGHT_GOLD_HIGH, [255, 255, 255], LIGHT_BLACK_HIGH, FLOOR_LIGHT) },
    { output: 'heart_ascii_dark.mp4', bg: [0, 0, 0], fgFn: makeFgFn([0, 0, 0], [0, 0, 0], DARK_GOLD_HIGH, [0, 0, 0], DARK_BLACK_HIGH, FLOOR_DARK) },
  ];

  console.log('Building per-cell inorganic shape masks...');
  const cellMasks = buildCellMasks();

  const usedFrameCount = asciiFrames.length;
  let done = 0;
  for (const variant of variants) {
    encodeVariant(asciiFrames, usedFrameCount, variant, cellMasks, () => {
      done++;
      if (done === variants.length) {
        console.log('Both variants complete.');
      }
    });
  }
});

// A big, round dot per grid cell (same mask reused for every frame — only
// its fill color animates).
function buildCellMasks() {
  const masks = new Array(COLS * ROWS);
  const w = ssCellW, h = ssCellH;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * 0.5 * 0.78; // dot radius relative to cell; bigger cells + this ratio = more gap and bigger dots

  const mask = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) {
        mask[py * w + px] = 1;
      }
    }
  }

  for (let i = 0; i < COLS * ROWS; i++) masks[i] = mask;
  return masks;
}

function encodeVariant(asciiFrames, frameCount, { output, bg, fgFn }, cellMasks, cb) {
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

    const lines = asciiFrames[framesWritten].split('\n');
    for (let r = 0; r < lines.length; r++) {
      const line = lines[r];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === ' ') continue;
        const brightness = charBrightness[ch] || 0;
        if (brightness === 0) continue;

        const t = brightness / 255;
        const [rv, gv, bv] = fgFn(t, c, r);

        const mask = cellMasks[r * COLS + c];
        const startX = c * ssCellW;
        const startY = r * ssCellH;
        for (let py = 0; py < ssCellH && startY + py < ssH; py++) {
          for (let px = 0; px < ssCellW && startX + px < ssW; px++) {
            if (!mask[py * ssCellW + px]) continue;
            const idx = ((startY + py) * ssW + (startX + px)) * 3;
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
