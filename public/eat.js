// eat.js — a small vanilla-JS maze-chomp game on canvas, in the same
// gameplay family as classic dot-eating maze games but with entirely
// original geometric art (hand-drawn circles/arcs, not traced or copied
// character/sprite artwork from any existing franchise).
(() => {
  const canvas = document.getElementById("eat-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const scoreEl = document.getElementById("eat-score");
  const bestEl = document.getElementById("eat-best");
  const levelEl = document.getElementById("eat-level");
  const messageEl = document.getElementById("eat-message");
  const restartBtn = document.getElementById("eat-restart");

  const HIGH_SCORE_KEY = "nr-vse-webdev-eat-highscore";

  // Fire-and-forget usage telemetry (see analytics.js / server.js's
  // /api/game-event) — purely aggregate start/end + score counts, no
  // per-visitor identifier of any kind. Ignores failures entirely so a
  // slow/unavailable/disabled analytics backend can never affect gameplay.
  function reportGameEvent(event, score) {
    const body = { game: "eat", event };
    if (typeof score === "number") body.score = score;
    fetch("/api/game-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  // --- Maze layout ---------------------------------------------------
  const COLS = 17;
  const ROWS = 19;
  const TILE = canvas.width / COLS; // 24

  const UP = { dx: 0, dy: -1 };
  const DOWN = { dx: 0, dy: 1 };
  const LEFT = { dx: -1, dy: 0 };
  const RIGHT = { dx: 1, dy: 0 };
  const NONE = { dx: 0, dy: 0 };
  const ALL_DIRS = [UP, DOWN, LEFT, RIGHT];

  function key(col, row) {
    return `${col},${row}`;
  }

  const wallSet = new Set();

  function addWall(col, row) {
    wallSet.add(key(col, row));
  }

  // Border.
  for (let c = 0; c < COLS; c++) {
    addWall(c, 0);
    addWall(c, ROWS - 1);
  }
  for (let r = 0; r < ROWS; r++) {
    addWall(0, r);
    addWall(COLS - 1, r);
  }

  // Interior pillars — isolated single-cell obstacles (never adjacent to
  // each other or the border), placed with 4-fold symmetry for a tidy
  // look. Because each pillar is a lone cell surrounded by open floor,
  // removing it can never disconnect the maze, so every dot always stays
  // reachable — a deliberately simple, safe layout for a small lab demo
  // rather than a hand-authored corridor labyrinth.
  const PILLAR_BASE = [
    [3, 3], [3, 6], [6, 3], [6, 6],
  ];
  for (const [x, y] of PILLAR_BASE) {
    addWall(x, y);
    addWall(COLS - 1 - x, y);
    addWall(x, ROWS - 1 - y);
    addWall(COLS - 1 - x, ROWS - 1 - y);
  }

  function isWall(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return true;
    return wallSet.has(key(col, row));
  }

  function canMove(col, row, dir) {
    return !isWall(col + dir.dx, row + dir.dy);
  }

  const POWER_CELLS = [
    [1, 1],
    [COLS - 2, 1],
    [1, ROWS - 2],
    [COLS - 2, ROWS - 2],
  ];

  const PLAYER_START = { col: Math.floor(COLS / 2), row: ROWS - 2 };

  const GHOST_DEFS = [
    { color: "#ff3b3b", eyeGlow: "#ffdede", start: { col: 2, row: 2 } },
    { color: "#33e6ff", eyeGlow: "#e0feff", start: { col: COLS - 3, row: 2 } },
    { color: "#ff7ad9", eyeGlow: "#ffe6f8", start: { col: 2, row: ROWS - 3 } },
    { color: "#ff9c33", eyeGlow: "#ffe9d2", start: { col: COLS - 3, row: ROWS - 3 } },
  ];

  let dotSet, powerSet, player, ghosts, score, level, elapsed, running, gameOver, lastTime, rafId, vulnerableUntil;

  function loadHighScore() {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  function saveHighScore(value) {
    localStorage.setItem(HIGH_SCORE_KEY, String(value));
  }

  let highScore = loadHighScore();

  function populateDots() {
    dotSet = new Set();
    powerSet = new Set(POWER_CELLS.map(([c, r]) => key(c, r)));
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < COLS - 1; c++) {
        const k = key(c, r);
        if (wallSet.has(k) || powerSet.has(k)) continue;
        dotSet.add(k);
      }
    }
  }

  function resetPositions() {
    player = {
      colF: PLAYER_START.col,
      rowF: PLAYER_START.row,
      dir: NONE,
      nextDir: NONE,
      facing: 0,
      chompPhase: 0,
    };
    ghosts = GHOST_DEFS.map((def) => ({
      colF: def.start.col,
      rowF: def.start.row,
      dir: NONE,
      color: def.color,
      eyeGlow: def.eyeGlow,
      respawning: false,
      respawnUntil: 0,
      spawn: def.start,
    }));
  }

  const GHOST_SPEED_BASE = 4.0; // cells/sec
  const GHOST_SPEED_PER_LEVEL = 0.25;
  const GHOST_SPEED_MAX = 6.2;
  const GHOST_VULNERABLE_SPEED = 2.6;
  const PLAYER_SPEED = 5.2; // cells/sec
  const VULNERABLE_DURATION = 7; // seconds
  const VULNERABLE_FLASH_WINDOW = 2; // seconds before it ends
  const RESPAWN_DELAY = 1.5; // seconds
  const RANDOM_MOVE_CHANCE = 0.12;
  const TURN_EPSILON = 0.16;

  function ghostSpeed() {
    return Math.min(GHOST_SPEED_MAX, GHOST_SPEED_BASE + GHOST_SPEED_PER_LEVEL * (level - 1));
  }

  function reset() {
    populateDots();
    resetPositions();
    score = 0;
    level = 1;
    elapsed = 0;
    vulnerableUntil = -1;
    running = true;
    gameOver = false;
    lastTime = null;
    messageEl.textContent = "";
    updateHud();
  }

  function levelUp() {
    level += 1;
    populateDots();
    resetPositions();
    messageEl.textContent = `Level ${level}! Ghosts are getting faster…`;
  }

  function updateHud() {
    scoreEl.textContent = String(Math.floor(score));
    bestEl.textContent = String(Math.max(highScore, Math.floor(score)));
    levelEl.textContent = String(level);
  }

  function endGame() {
    running = false;
    gameOver = true;
    const finalScore = Math.floor(score);
    if (finalScore > highScore) {
      highScore = finalScore;
      saveHighScore(highScore);
    }
    updateHud();
    messageEl.textContent = `Game over! Score ${finalScore}. Press Restart to try again.`;
    reportGameEvent("end", finalScore);
  }

  function isVulnerable() {
    return elapsed < vulnerableUntil;
  }

  function chooseGhostDirection(ghost, playerCol, playerRow, vulnerable) {
    const curCol = Math.round(ghost.colF);
    const curRow = Math.round(ghost.rowF);
    let candidates = ALL_DIRS.filter((d) => canMove(curCol, curRow, d));
    const reverse = { dx: -ghost.dir.dx, dy: -ghost.dir.dy };
    const nonReverse = candidates.filter((d) => !(d.dx === reverse.dx && d.dy === reverse.dy));
    if (nonReverse.length) candidates = nonReverse;
    if (!candidates.length) return ghost.dir;

    if (Math.random() < RANDOM_MOVE_CHANCE) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    let bestDir = candidates[0];
    let bestDist = vulnerable ? -Infinity : Infinity;
    for (const d of candidates) {
      const nc = curCol + d.dx;
      const nr = curRow + d.dy;
      const dist = Math.hypot(nc - playerCol, nr - playerRow);
      if (vulnerable ? dist > bestDist : dist < bestDist) {
        bestDist = dist;
        bestDir = d;
      }
    }
    return bestDir;
  }

  function stepEntity(entity, speed, dt, isPlayer) {
    const col = Math.round(entity.colF);
    const row = Math.round(entity.rowF);
    const atCol = Math.abs(entity.colF - col) < TURN_EPSILON;
    const atRow = Math.abs(entity.rowF - row) < TURN_EPSILON;
    if (atCol && atRow && isPlayer) {
      // Only decide a *new* direction (and snap exactly to the cell) when
      // it actually changes — turning or coming to a stop. Re-snapping to
      // the same integer on every frame that merely passes near an
      // intersection (which spans several frames, since one frame's worth
      // of movement is smaller than TURN_EPSILON) would discard that
      // frame's forward progress every time and permanently trap the
      // entity oscillating around the intersection, which is exactly the
      // "animates in place but never moves" bug this fixes.
      let newDir = entity.dir;
      if (entity.nextDir !== NONE && canMove(col, row, entity.nextDir)) {
        newDir = entity.nextDir;
      } else if (!canMove(col, row, entity.dir)) {
        newDir = NONE;
      }
      if (newDir !== entity.dir) {
        entity.dir = newDir;
        entity.colF = col;
        entity.rowF = row;
      }
      if (entity.dir !== NONE) entity.facing = Math.atan2(entity.dir.dy, entity.dir.dx);
    }
    entity.colF += entity.dir.dx * speed * dt;
    entity.rowF += entity.dir.dy * speed * dt;
  }

  function update(dt) {
    if (!running) return;
    elapsed += dt;

    stepEntity(player, PLAYER_SPEED, dt, true);
    if (player.dir !== NONE) player.chompPhase += dt * 9;

    const playerCol = Math.round(player.colF);
    const playerRow = Math.round(player.rowF);

    // Eat dots / power pellets under the player.
    const pk = key(playerCol, playerRow);
    if (dotSet.has(pk)) {
      dotSet.delete(pk);
      score += 10;
    }
    if (powerSet.has(pk)) {
      powerSet.delete(pk);
      score += 50;
      vulnerableUntil = elapsed + VULNERABLE_DURATION;
    }

    const vulnerable = isVulnerable();

    for (const ghost of ghosts) {
      if (ghost.respawning) {
        if (elapsed >= ghost.respawnUntil) {
          ghost.respawning = false;
          ghost.colF = ghost.spawn.col;
          ghost.rowF = ghost.spawn.row;
          ghost.dir = NONE;
        }
        continue;
      }

      const col = Math.round(ghost.colF);
      const row = Math.round(ghost.rowF);
      const atCol = Math.abs(ghost.colF - col) < TURN_EPSILON;
      const atRow = Math.abs(ghost.rowF - row) < TURN_EPSILON;
      if (atCol && atRow) {
        // Same fix as stepEntity(): only snap position + adopt a new
        // direction when the chosen direction actually differs from the
        // current one, so continuing straight through an intersection
        // never gets its forward progress reset frame after frame.
        const newDir = chooseGhostDirection(ghost, playerCol, playerRow, vulnerable);
        if (newDir !== ghost.dir) {
          ghost.dir = newDir;
          ghost.colF = col;
          ghost.rowF = row;
        }
      }
      const speed = vulnerable ? GHOST_VULNERABLE_SPEED : ghostSpeed();
      ghost.colF += ghost.dir.dx * speed * dt;
      ghost.rowF += ghost.dir.dy * speed * dt;
    }

    // Collisions.
    for (const ghost of ghosts) {
      if (ghost.respawning) continue;
      const dist = Math.hypot(ghost.colF - player.colF, ghost.rowF - player.rowF);
      if (dist < 0.6) {
        if (isVulnerable()) {
          score += 200;
          ghost.respawning = true;
          ghost.respawnUntil = elapsed + RESPAWN_DELAY;
        } else {
          endGame();
          return;
        }
      }
    }

    if (dotSet.size === 0 && powerSet.size === 0) {
      levelUp();
    }

    updateHud();
  }

  // --- Drawing ---------------------------------------------------------

  function cellCenter(colF, rowF) {
    return [(colF + 0.5) * TILE, (rowF + 0.5) * TILE];
  }

  function drawMaze() {
    ctx.save();
    ctx.fillStyle = "rgba(0, 229, 255, 0.16)";
    ctx.strokeStyle = "rgba(0, 229, 255, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(0, 229, 255, 0.5)";
    ctx.shadowBlur = 4;
    for (const k of wallSet) {
      const [c, r] = k.split(",").map(Number);
      const x = c * TILE;
      const y = r * TILE;
      ctx.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
      ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
    }
    ctx.restore();
  }

  function drawDots() {
    ctx.save();
    ctx.fillStyle = "#ffe9a8";
    for (const k of dotSet) {
      const [c, r] = k.split(",").map(Number);
      const [cx, cy] = cellCenter(c, r);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, TILE * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    const pulse = 0.75 + 0.25 * Math.sin(elapsed * 5);
    ctx.fillStyle = "#fff3c4";
    ctx.shadowColor = "rgba(255, 243, 196, 0.85)";
    ctx.shadowBlur = 8;
    for (const k of powerSet) {
      const [c, r] = k.split(",").map(Number);
      const [cx, cy] = cellCenter(c, r);
      ctx.beginPath();
      ctx.arc(cx, cy, TILE * 0.24 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPlayer() {
    const [px, py] = cellCenter(player.colF, player.rowF);
    const r = TILE * 0.42;
    const moving = player.dir !== NONE;
    const mouthHalf = moving ? 0.12 + Math.abs(Math.sin(player.chompPhase)) * 0.62 : 0.22;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(player.facing);
    ctx.shadowColor = "rgba(255, 212, 0, 0.85)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#ffd400";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, mouthHalf, Math.PI * 2 - mouthHalf);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function ghostPath(px, py, r) {
    const top = py - r * 0.15;
    const bottom = py + r * 0.9;
    const bumps = 4;
    const bumpW = (2 * r) / bumps;
    ctx.beginPath();
    ctx.moveTo(px - r, bottom);
    ctx.lineTo(px - r, top);
    ctx.arc(px, top, r, Math.PI, 0, false);
    ctx.lineTo(px + r, bottom);
    for (let i = bumps; i >= 1; i--) {
      const x1 = px - r + i * bumpW;
      const xMid = x1 - bumpW / 2;
      ctx.quadraticCurveTo(xMid, bottom + r * 0.3, x1 - bumpW, bottom);
    }
    ctx.closePath();
  }

  function drawGhost(ghost) {
    if (ghost.respawning) return;
    const [px, py] = cellCenter(ghost.colF, ghost.rowF);
    const r = TILE * 0.44;
    const vulnerable = isVulnerable();
    let fill = ghost.color;
    if (vulnerable) {
      const remaining = vulnerableUntil - elapsed;
      if (remaining < VULNERABLE_FLASH_WINDOW) {
        fill = Math.floor(elapsed * 8) % 2 === 0 ? "#2f6fff" : "#ffffff";
      } else {
        fill = "#2f6fff";
      }
    }

    ctx.save();
    ctx.shadowColor = vulnerable ? "rgba(47, 111, 255, 0.7)" : `${ghost.color}aa`;
    ctx.shadowBlur = 8;
    ghostPath(px, py, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Eyes — simple ovals with dark pupils, looking in the current
    // direction of travel (or forward if standing still).
    const dir = ghost.dir === NONE ? RIGHT : ghost.dir;
    const eyeOffsetX = r * 0.32;
    const eyeY = py - r * 0.1;
    const eyeR = r * 0.22;
    const pupilR = r * 0.11;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(px - eyeOffsetX, eyeY, eyeR, 0, Math.PI * 2);
    ctx.arc(px + eyeOffsetX, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = vulnerable ? "#0f0c29" : "#12183a";
    ctx.beginPath();
    ctx.arc(px - eyeOffsetX + dir.dx * pupilR * 0.9, eyeY + dir.dy * pupilR * 0.9, pupilR, 0, Math.PI * 2);
    ctx.arc(px + eyeOffsetX + dir.dx * pupilR * 0.9, eyeY + dir.dy * pupilR * 0.9, pupilR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0f0c29";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawMaze();
    drawDots();
    for (const ghost of ghosts) drawGhost(ghost);
    drawPlayer();

    if (gameOver) {
      ctx.fillStyle = "rgba(15, 12, 41, 0.6)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f4f4fb";
      ctx.font = "bold 26px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Game Over", canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = "16px 'Segoe UI', Arial, sans-serif";
      ctx.fillText("Press Restart to try again", canvas.width / 2, canvas.height / 2 + 18);
      ctx.textAlign = "start";
    }
  }

  function loop(timestamp) {
    if (lastTime === null) lastTime = timestamp;
    const dt = Math.min(0.05, (timestamp - lastTime) / 1000);
    lastTime = timestamp;

    update(dt);
    draw();

    rafId = requestAnimationFrame(loop);
  }

  function start() {
    reset();
    draw();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
    reportGameEvent("start");
  }

  // --- Input handling ---
  const KEY_DIR_MAP = {
    ArrowUp: UP,
    KeyW: UP,
    ArrowDown: DOWN,
    KeyS: DOWN,
    ArrowLeft: LEFT,
    KeyA: LEFT,
    ArrowRight: RIGHT,
    KeyD: RIGHT,
  };

  window.addEventListener("keydown", (e) => {
    const dir = KEY_DIR_MAP[e.code];
    if (dir) {
      e.preventDefault();
      if (gameOver) {
        start();
        return;
      }
      player.nextDir = dir;
    } else if (e.code === "Space" && gameOver) {
      e.preventDefault();
      start();
    }
  });

  canvas.addEventListener("pointerdown", () => {
    if (gameOver) start();
  });

  restartBtn.addEventListener("click", () => {
    start();
  });

  start();
})();
