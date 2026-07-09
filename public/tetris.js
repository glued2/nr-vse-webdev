// tetris.js — small vanilla-JS Tetris-like game rendered on a canvas.
(() => {
  const COLS = 10;
  const ROWS = 20;
  const CELL = 24;

  const canvas = document.getElementById("tetris-canvas");
  const nextCanvas = document.getElementById("tetris-next-canvas");
  if (!canvas || !nextCanvas) return;

  const ctx = canvas.getContext("2d");
  const nextCtx = nextCanvas.getContext("2d");

  const scoreEl = document.getElementById("tetris-score");
  const linesEl = document.getElementById("tetris-lines");
  const levelEl = document.getElementById("tetris-level");
  const messageEl = document.getElementById("tetris-message");
  const restartBtn = document.getElementById("tetris-restart");
  const pauseBtn = document.getElementById("tetris-pause");

  // Palette drawn from the site's own color scheme (cyan/magenta accents plus
  // a few complementary purples/teals/blues so pieces are easy to tell apart
  // against the dark gradient background).
  const COLORS = {
    I: "#00e5ff", // cyan accent
    O: "#ffd23f", // warm yellow
    T: "#ff2fd4", // magenta accent
    S: "#3ddc97", // teal/green
    Z: "#ff5d73", // pink-red
    J: "#5c7cfa", // blue
    L: "#ff9f45", // orange
  };

  const SHAPES = {
    I: [
      [0, 0], [1, 0], [2, 0], [3, 0],
    ],
    O: [
      [0, 0], [1, 0], [0, 1], [1, 1],
    ],
    T: [
      [0, 0], [1, 0], [2, 0], [1, 1],
    ],
    S: [
      [1, 0], [2, 0], [0, 1], [1, 1],
    ],
    Z: [
      [0, 0], [1, 0], [1, 1], [2, 1],
    ],
    J: [
      [0, 0], [0, 1], [1, 1], [2, 1],
    ],
    L: [
      [2, 0], [0, 1], [1, 1], [2, 1],
    ],
  };

  const PIECE_NAMES = Object.keys(SHAPES);

  function rotateCells(cells) {
    // Rotate around the piece's bounding-box center using simple 90deg matrix
    // rotation on a 4x4 grid, then normalize back to a compact bounding box.
    const rotated = cells.map(([x, y]) => [3 - y, x]);
    const minX = Math.min(...rotated.map((c) => c[0]));
    const minY = Math.min(...rotated.map((c) => c[1]));
    return rotated.map(([x, y]) => [x - minX, y - minY]);
  }

  function randomPieceName() {
    return PIECE_NAMES[Math.floor(Math.random() * PIECE_NAMES.length)];
  }

  function makePiece(name) {
    return {
      name,
      cells: SHAPES[name].map((c) => c.slice()),
      color: COLORS[name],
      x: Math.floor(COLS / 2) - 2,
      y: 0,
    };
  }

  // --- Leveling / fall-speed curve --------------------------------------
  //
  // Levels advance every LINES_PER_LEVEL cleared lines (previously 10 —
  // players felt leveling was far too slow, e.g. only reaching level 4
  // after 34 lines). Fall speed is derived from the level via a
  // percentage-based decay (each level shaves off a fixed *fraction* of
  // the current interval, not a fixed number of ms) so the speedup stays
  // clearly noticeable level-to-level while naturally tapering off as it
  // approaches MIN_DROP_INTERVAL, rather than the old flat -70ms/level
  // step which produced only a barely-perceptible ~9% change at low
  // levels and would go negative/clamp abruptly at high levels.
  const LINES_PER_LEVEL = 5;
  const BASE_DROP_INTERVAL = 800;
  const MIN_DROP_INTERVAL = 100;
  const DROP_INTERVAL_DECAY = 0.86; // ~14% faster falls per level

  function dropIntervalForLevel(lvl) {
    return Math.max(MIN_DROP_INTERVAL, BASE_DROP_INTERVAL * Math.pow(DROP_INTERVAL_DECAY, lvl - 1));
  }

  let board = createEmptyBoard();
  let current = makePiece(randomPieceName());
  let next = randomPieceName();
  let score = 0;
  let lines = 0;
  let level = 1;
  let dropInterval = BASE_DROP_INTERVAL;
  let dropCounter = 0;
  let lastTime = 0;
  let paused = false;
  let gameOver = false;
  let rafId = null;

  // Fire-and-forget usage telemetry (see analytics.js / server.js's
  // /api/game-event) — purely aggregate start/end + score counts, no
  // per-visitor identifier of any kind. Ignores failures entirely so a
  // slow/unavailable/disabled analytics backend can never affect gameplay.
  function reportGameEvent(event, eventScore) {
    const body = { game: "blocks", event };
    if (typeof eventScore === "number") body.score = eventScore;
    fetch("/api/game-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  function createEmptyBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function occupiedCells(piece) {
    return piece.cells.map(([cx, cy]) => [piece.x + cx, piece.y + cy]);
  }

  function collides(piece, offsetX = 0, offsetY = 0, cells = piece.cells) {
    return cells.some(([cx, cy]) => {
      const x = piece.x + cx + offsetX;
      const y = piece.y + cy + offsetY;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y < 0) return false;
      return board[y][x] !== null;
    });
  }

  function lockPiece() {
    occupiedCells(current).forEach(([x, y]) => {
      if (y >= 0) board[y][x] = current.color;
    });
    clearLines();
    spawnNext();
  }

  function clearLines() {
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (board[y].every((cell) => cell !== null)) {
        board.splice(y, 1);
        board.unshift(Array(COLS).fill(null));
        cleared++;
        y++; // re-check the same row index after the shift
      }
    }
    if (cleared > 0) {
      const points = [0, 100, 300, 500, 800][cleared] || cleared * 200;
      score += points * level;
      lines += cleared;
      level = 1 + Math.floor(lines / LINES_PER_LEVEL);
      dropInterval = dropIntervalForLevel(level);
      updateStats();
    }
  }

  function spawnNext() {
    current = makePiece(next);
    next = randomPieceName();
    drawNextPreview();
    if (collides(current)) {
      gameOver = true;
      messageEl.textContent = "Game over — press Restart to play again.";
      reportGameEvent("end", score);
    }
  }

  function updateStats() {
    scoreEl.textContent = String(score);
    linesEl.textContent = String(lines);
    levelEl.textContent = String(level);
  }

  function move(dx) {
    if (gameOver || paused) return;
    if (!collides(current, dx, 0)) {
      current.x += dx;
      draw();
    }
  }

  function softDrop() {
    if (gameOver || paused) return;
    if (!collides(current, 0, 1)) {
      current.y += 1;
      score += 1;
      updateStats();
    } else {
      lockPiece();
    }
    draw();
  }

  function hardDrop() {
    if (gameOver || paused) return;
    let dist = 0;
    while (!collides(current, 0, 1)) {
      current.y += 1;
      dist++;
    }
    score += dist * 2;
    updateStats();
    lockPiece();
    draw();
  }

  function rotate() {
    if (gameOver || paused) return;
    const rotated = rotateCells(current.cells);
    // Try the rotation as-is, then a couple of simple wall-kick offsets.
    const kicks = [0, -1, 1, -2, 2];
    for (const kick of kicks) {
      if (!collides(current, kick, 0, rotated)) {
        current.cells = rotated;
        current.x += kick;
        draw();
        return;
      }
    }
  }

  function togglePause() {
    if (gameOver) return;
    paused = !paused;
    messageEl.textContent = paused ? "Paused" : "";
    if (pauseBtn) {
      pauseBtn.textContent = paused ? "Resume" : "Pause";
      pauseBtn.classList.toggle("is-paused", paused);
    }
    if (!paused) {
      lastTime = performance.now();
    }
    draw();
  }

  function drawCell(context, x, y, size, color) {
    context.fillStyle = color;
    context.fillRect(x + 1, y + 1, size - 2, size - 2);
    context.strokeStyle = "rgba(255,255,255,0.15)";
    context.strokeRect(x + 1, y + 1, size - 2, size - 2);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Board background
    ctx.fillStyle = "#0f0c29";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const cell = board[y][x];
        if (cell) drawCell(ctx, x * CELL, y * CELL, CELL, cell);
      }
    }

    if (!gameOver) {
      occupiedCells(current).forEach(([x, y]) => {
        if (y >= 0) drawCell(ctx, x * CELL, y * CELL, CELL, current.color);
      });
    }

    if (paused && !gameOver) {
      ctx.fillStyle = "rgba(15, 12, 41, 0.7)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f4f4fb";
      ctx.font = "bold 18px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Paused", canvas.width / 2, canvas.height / 2);
    }
  }

  function drawNextPreview() {
    nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
    nextCtx.fillStyle = "#0f0c29";
    nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
    const cells = SHAPES[next];
    const size = 20;
    const maxX = Math.max(...cells.map((c) => c[0]));
    const maxY = Math.max(...cells.map((c) => c[1]));
    const offsetX = (nextCanvas.width - (maxX + 1) * size) / 2;
    const offsetY = (nextCanvas.height - (maxY + 1) * size) / 2;
    cells.forEach(([cx, cy]) => {
      drawCell(nextCtx, offsetX + cx * size, offsetY + cy * size, size, COLORS[next]);
    });
  }

  function tick(time = 0) {
    if (!gameOver && !paused) {
      const delta = time - lastTime;
      lastTime = time;
      dropCounter += delta;
      if (dropCounter > dropInterval) {
        dropCounter = 0;
        if (!collides(current, 0, 1)) {
          current.y += 1;
        } else {
          lockPiece();
        }
        draw();
      }
    } else {
      lastTime = time;
    }
    rafId = requestAnimationFrame(tick);
  }

  function restart() {
    board = createEmptyBoard();
    score = 0;
    lines = 0;
    level = 1;
    dropInterval = BASE_DROP_INTERVAL;
    dropCounter = 0;
    gameOver = false;
    paused = false;
    messageEl.textContent = "";
    if (pauseBtn) {
      pauseBtn.textContent = "Pause";
      pauseBtn.classList.remove("is-paused");
    }
    reportGameEvent("start");
    next = randomPieceName();
    spawnNext();
    updateStats();
    draw();
  }

  document.addEventListener("keydown", (e) => {
    switch (e.code) {
      case "ArrowLeft":
        e.preventDefault();
        move(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        move(1);
        break;
      case "ArrowDown":
        e.preventDefault();
        softDrop();
        break;
      case "ArrowUp":
        e.preventDefault();
        rotate();
        break;
      case "Space":
        e.preventDefault();
        hardDrop();
        break;
      case "KeyP":
        e.preventDefault();
        togglePause();
        break;
      case "Escape":
        e.preventDefault();
        togglePause();
        break;
      default:
        break;
    }
  });

  restartBtn.addEventListener("click", restart);
  if (pauseBtn) {
    pauseBtn.addEventListener("click", togglePause);
  }

  restart();
  rafId = requestAnimationFrame(tick);

  window.addEventListener("beforeunload", () => {
    if (rafId) cancelAnimationFrame(rafId);
  });
})();
