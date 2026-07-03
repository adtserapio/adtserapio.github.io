(function () {
  var canvas = document.getElementById('ascii-canvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d', { alpha: true });
  var frames = null;
  var currentFrame = 0;
  var lastFrameTime = 0;
  var frameDuration = 0;
  var rafId = null;
  var paused = false;
  var glyphColor = '';

  var wrap = canvas.parentElement;

  function rleDecode(row) {
    return row.replace(/~(\d+)\|/g, function (_, n) {
      return ' '.repeat(Number(n));
    });
  }

  function getColor() {
    return getComputedStyle(wrap).color;
  }

  function sizeCanvas(data) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = wrap.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);
    return { w: rect.width, h: rect.height };
  }

  function paintFrame(frameIdx, size) {
    var data = frames;
    if (!data) return;

    var cols = data.cols;
    var rows = data.rows;
    var cellW = size.w / cols;
    var cellH = size.h / rows;
    var fontSize = Math.floor(Math.min(cellW * 1.6, cellH * 0.9));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = fontSize + 'px "Courier New", Courier, monospace';
    ctx.fillStyle = glyphColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    var frame = data.frames[frameIdx];
    for (var r = 0; r < rows; r++) {
      var row = frame[r];
      var y = r * cellH + cellH / 2;
      for (var c = 0; c < row.length; c++) {
        var ch = row[c];
        if (ch !== ' ') {
          ctx.fillText(ch, c * cellW + cellW / 2, y);
        }
      }
    }
  }

  var size = { w: 0, h: 0 };

  function loop(ts) {
    if (paused || !frames) {
      rafId = requestAnimationFrame(loop);
      return;
    }
    if (ts - lastFrameTime >= frameDuration) {
      lastFrameTime = ts;
      currentFrame = (currentFrame + 1) % frames.frameCount;
      paintFrame(currentFrame, size);
    }
    rafId = requestAnimationFrame(loop);
  }

  function init(data) {
    frames = data;
    // Decode all RLE once
    for (var i = 0; i < data.frames.length; i++) {
      for (var j = 0; j < data.frames[i].length; j++) {
        data.frames[i][j] = rleDecode(data.frames[i][j]);
      }
    }
    frameDuration = 1000 / data.fps;
    glyphColor = getColor();
    size = sizeCanvas(data);
    paintFrame(0, size);
    rafId = requestAnimationFrame(loop);
  }

  // Theme change detection
  var observer = new MutationObserver(function () {
    var newColor = getColor();
    if (newColor !== glyphColor) {
      glyphColor = newColor;
      if (frames) paintFrame(currentFrame, size);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

  // Visibility pause
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      paused = true;
    } else {
      paused = false;
      lastFrameTime = 0;
    }
  });

  // Resize
  window.addEventListener('resize', function () {
    if (!frames) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    size = sizeCanvas(frames);
    paintFrame(currentFrame, size);
  });

  // Deferred load
  function load() {
    fetch('heart_ascii.json')
      .then(function (r) { return r.json(); })
      .then(init);
  }

  if ('requestIdleCallback' in window) {
    requestIdleCallback(load, { timeout: 1500 });
  } else {
    setTimeout(load, 200);
  }
})();
