// jump.js — a small vanilla-JS Chrome-dino-style endless runner on canvas.
(() => {
  const canvas = document.getElementById("jump-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const scoreEl = document.getElementById("jump-score");
  const bestEl = document.getElementById("jump-best");
  const messageEl = document.getElementById("jump-message");
  const restartBtn = document.getElementById("jump-restart");

  const HIGH_SCORE_KEY = "nr-vse-webdev-jump-highscore";

  // Logical (design-resolution) canvas size — CSS scales it responsively,
  // we just draw in these coordinates. Bumped up 1.5x from the original
  // 600x220 for a roomier, less cramped playing window; all pixel-based
  // constants below are scaled by the same 1.5x factor so the game feels
  // identical, just bigger (see the physics note below for why that's safe).
  const WIDTH = canvas.width; // 900
  const HEIGHT = canvas.height; // 330
  const GROUND_Y = HEIGHT - 45;

  const PLAYER_X = 105;
  const PLAYER_SIZE = 39;
  const DUCK_HEIGHT = 21;

  // Tuned for a floaty, forgiving arc: apex rise ~170px, ~0.73s total airtime
  // (scaling both velocity and gravity by the same factor keeps airtime and
  // gameplay feel unchanged — only the distances involved get bigger). That
  // clears the tallest obstacle (66px) with ~113px of margin, and the
  // "high enough to clear" window (~0.6s) is wide relative to how briefly an
  // obstacle actually overlaps the player horizontally (well under 0.1s even
  // at max speed) — so a jump timed anywhere in a comfortable window clears
  // cleanly. See the physics notes in the PR description for the full math.
  const GRAVITY = 2550; // px/s^2
  const JUMP_VELOCITY = -930; // px/s

  const BASE_SPEED = 330; // px/s
  const MAX_SPEED = 840;
  const SPEED_RAMP = 9; // px/s per second survived

  // Small forgiving hitbox insets so near-misses feel fair rather than cheap
  // (the drawn sprite is a bit bigger than what actually causes a collision).
  const PLAYER_HITBOX_INSET_X = 7.5;
  const PLAYER_HITBOX_INSET_Y = 4.5;
  const OBSTACLE_HITBOX_INSET = 4.5;

  let player, obstacles, speed, distance, score, elapsed, running, gameOver, lastTime, spawnTimer, spawnGap, rafId;

  // Parallax background decoration — generated once, scrolled by `distance`.
  // A few more stars/hexes than before since the canvas area is bigger.
  const FAR_LAYER = Array.from({ length: 28 }, () => ({
    x: Math.random() * WIDTH,
    y: 12 + Math.random() * (GROUND_Y - 45),
    r: 1.5 + Math.random() * 2.1,
    speedFactor: 0.06,
  }));
  const NEAR_LAYER = Array.from({ length: 13 }, () => ({
    x: Math.random() * WIDTH,
    y: 24 + Math.random() * (GROUND_Y - 90),
    r: 6 + Math.random() * 7.5,
    speedFactor: 0.18,
  }));

  function loadHighScore() {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  function saveHighScore(value) {
    localStorage.setItem(HIGH_SCORE_KEY, String(value));
  }

  let highScore = loadHighScore();

  function reset() {
    player = {
      y: GROUND_Y - PLAYER_SIZE,
      vy: 0,
      ducking: false,
      onGround: true,
      legPhase: 0,
    };
    obstacles = [];
    speed = BASE_SPEED;
    distance = 0;
    score = 0;
    elapsed = 0;
    running = true;
    gameOver = false;
    lastTime = null;
    spawnTimer = 0;
    spawnGap = randomSpawnGap();
    messageEl.textContent = "";
    updateHud();
  }

  function randomSpawnGap() {
    // Seconds until next obstacle spawns; shrinks a bit as speed increases.
    return 0.9 + Math.random() * 1.1;
  }

  function playerHeight() {
    return player.ducking && player.onGround ? DUCK_HEIGHT : PLAYER_SIZE;
  }

  // NOTE: previously this recomputed a fixed ground-relative top and ignored
  // player.y entirely, so the physics in update() silently had no visible or
  // collidable effect — jumping never actually moved the player. Fixed by
  // reading the real simulated position.
  function playerTop() {
    return player.y;
  }

  function jump() {
    if (gameOver) return;
    if (player.onGround && !player.ducking) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
    }
  }

  function setDuck(isDucking) {
    if (gameOver) return;
    player.ducking = isDucking;
  }

  function spawnObstacle() {
    // Occasionally spawn a taller obstacle, or a low "flying" one that's
    // clearly telegraphed as duck-or-jump, to keep things interesting.
    const roll = Math.random();
    let width, height, y, kind;
    if (roll < 0.08) {
      // Low flying obstacle — telegraphed with a distinct diamond shape and
      // a duck-arrow hint. Can be ducked under OR jumped over.
      kind = "fly";
      width = 45;
      height = 24;
      y = GROUND_Y - PLAYER_SIZE - 9;
    } else if (roll < 0.32) {
      kind = "tall";
      width = 33;
      height = 66;
      y = GROUND_Y - height;
    } else {
      kind = "block";
      width = 30 + Math.random() * 18;
      height = 39 + Math.random() * 21;
      y = GROUND_Y - height;
    }
    obstacles.push({ x: WIDTH + width, y, width, height, kind });
  }

  function updateHud() {
    scoreEl.textContent = String(Math.floor(score));
    bestEl.textContent = String(Math.max(highScore, Math.floor(score)));
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
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
  }

  function update(dt) {
    if (!running) return;

    elapsed += dt;
    distance += speed * dt;
    score = distance / 8;
    speed = Math.min(MAX_SPEED, BASE_SPEED + SPEED_RAMP * elapsed);

    // Player physics
    if (!player.onGround) {
      player.vy += GRAVITY * dt;
      player.y += player.vy * dt;
      const landingTop = GROUND_Y - PLAYER_SIZE;
      if (player.y >= landingTop) {
        player.y = landingTop;
        player.vy = 0;
        player.onGround = true;
      }
    } else {
      player.y = GROUND_Y - playerHeight();
      // Animate running legs — cadence speeds up with the game's speed.
      player.legPhase += dt * (8 + speed / 40);
    }

    // Obstacles
    spawnTimer += dt;
    if (spawnTimer >= spawnGap) {
      spawnTimer = 0;
      spawnGap = randomSpawnGap();
      spawnObstacle();
    }

    for (const obs of obstacles) {
      obs.x -= speed * dt;
    }
    obstacles = obstacles.filter((obs) => obs.x + obs.width > -10);

    // Collision detection against a slightly forgiving hitbox — a bit
    // smaller than the drawn sprite on both the player and the obstacle,
    // so close near-misses read as fair rather than cheap.
    const pTop = playerTop() + PLAYER_HITBOX_INSET_Y;
    const pHeight = Math.max(4, playerHeight() - PLAYER_HITBOX_INSET_Y * 2);
    const pLeft = PLAYER_X + PLAYER_HITBOX_INSET_X;
    const pWidth = Math.max(4, PLAYER_SIZE - PLAYER_HITBOX_INSET_X * 2);
    for (const obs of obstacles) {
      const ox = obs.x + OBSTACLE_HITBOX_INSET;
      const oy = obs.y + OBSTACLE_HITBOX_INSET;
      const ow = Math.max(2, obs.width - OBSTACLE_HITBOX_INSET * 2);
      const oh = Math.max(2, obs.height - OBSTACLE_HITBOX_INSET * 2);
      if (rectsOverlap(pLeft, pTop, pWidth, pHeight, ox, oy, ow, oh)) {
        endGame();
        break;
      }
    }

    updateHud();
  }

  // --- Drawing helpers ---

  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function hexPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawSky() {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, "rgba(0, 229, 255, 0.10)");
    sky.addColorStop(1, "rgba(255, 47, 212, 0.05)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, GROUND_Y);
  }

  function drawParallaxLayer(layer, isHex) {
    ctx.save();
    for (const p of layer) {
      let offset = (distance * p.speedFactor) % WIDTH;
      let x = p.x - offset;
      if (x < -10) x += WIDTH;
      if (isHex) {
        ctx.strokeStyle = "rgba(0, 229, 255, 0.18)";
        ctx.lineWidth = 1;
        hexPath(x, p.y, p.r);
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
        ctx.beginPath();
        ctx.arc(x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawGround() {
    ctx.fillStyle = "rgba(15, 12, 41, 1)";
    ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);

    ctx.save();
    ctx.shadowColor = "rgba(0, 229, 255, 0.6)";
    ctx.shadowBlur = 8;
    ctx.strokeStyle = "rgba(0, 229, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(WIDTH, GROUND_Y);
    ctx.stroke();

    // Scrolling tick marks to reinforce forward motion.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 2;
    const spacing = 51;
    const offset = distance % spacing;
    ctx.beginPath();
    for (let tx = -offset; tx < WIDTH; tx += spacing) {
      ctx.moveTo(tx, GROUND_Y + 4);
      ctx.lineTo(tx + 14, GROUND_Y + 4);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawPlayer() {
    const top = playerTop();
    const h = playerHeight();
    const airborne = !player.onGround;
    const ducking = player.ducking && player.onGround;
    const width = ducking ? PLAYER_SIZE + 8 : PLAYER_SIZE;
    const left = ducking ? PLAYER_X - 4 : PLAYER_X;
    const cx = left + width / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0, 229, 255, 0.85)";
    ctx.shadowBlur = 16;

    // Legs — tucked up while airborne or ducking, animated while running.
    if (!ducking) {
      const stride = (Math.sin(player.legPhase) + 1) / 2;
      const legSpread = airborne ? 2 : 5;
      const legLen = airborne ? 3 : 6 + stride * 4;
      ctx.strokeStyle = "rgba(0, 229, 255, 0.9)";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - legSpread, top + h - 2);
      ctx.lineTo(cx - legSpread - (airborne ? 0 : 2), top + h - 2 + legLen);
      ctx.moveTo(cx + legSpread, top + h - 2);
      ctx.lineTo(cx + legSpread + (airborne ? 0 : 2), top + h - 2 + (airborne ? legLen : legLen - stride * 3));
      ctx.stroke();
    }

    // Body — rounded glowing blob with a highlight gradient.
    const grad = ctx.createRadialGradient(cx - width * 0.15, top + h * 0.3, 2, cx, top + h / 2, width * 0.9);
    grad.addColorStop(0, "#eafffe");
    grad.addColorStop(0.45, "#5df1ff");
    grad.addColorStop(1, "#00a8c9");
    ctx.fillStyle = grad;
    roundRectPath(left, top, width, h, Math.min(9, h / 2));
    ctx.fill();

    // Eye — faces the direction of travel.
    ctx.shadowBlur = 0;
    const eyeX = left + width * 0.72;
    const eyeY = top + h * 0.36;
    const eyeR = Math.max(1.6, h * 0.13);
    ctx.fillStyle = "#0f0c29";
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function crystalPath(obs) {
    const { x, y, width: w, height: h } = obs;
    const cx = x + w / 2;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, y + h * 0.35);
    ctx.lineTo(x + w * 0.78, y + h);
    ctx.lineTo(x + w * 0.22, y + h);
    ctx.lineTo(x, y + h * 0.35);
    ctx.closePath();
  }

  function spikesPath(obs) {
    const { x, y, width: w, height: h } = obs;
    const baseY = y + h;
    const spikeW = w / 3;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + spikeW * 0.5, y + h * 0.42);
    ctx.lineTo(x + spikeW, baseY);
    ctx.lineTo(x + spikeW * 1.5, y);
    ctx.lineTo(x + spikeW * 2, baseY);
    ctx.lineTo(x + spikeW * 2.5, y + h * 0.42);
    ctx.lineTo(x + spikeW * 3, baseY);
    ctx.closePath();
  }

  function drawFlyer(obs) {
    const { x, y, width: w, height: h } = obs;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 6);

    ctx.save();
    ctx.shadowColor = "#ff2fd4";
    ctx.shadowBlur = 12 + pulse * 6;
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, "#fff2ff");
    grad.addColorStop(0.5, "#ff6df0");
    grad.addColorStop(1, "#ff2fd4");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, cy);
    ctx.lineTo(cx, y + h);
    ctx.lineTo(x, cy);
    ctx.closePath();
    ctx.fill();

    // Dashed halo + a down-arrow hint make this kind unmistakable at a glance.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.85, h * 0.75, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.moveTo(cx - 4, y + h + 2);
    ctx.lineTo(cx + 4, y + h + 2);
    ctx.lineTo(cx, y + h + 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawObstacles() {
    for (const obs of obstacles) {
      if (obs.kind === "fly") {
        drawFlyer(obs);
        continue;
      }
      ctx.save();
      ctx.shadowColor = "#ff2fd4";
      ctx.shadowBlur = 10;
      if (obs.kind === "tall") {
        const grad = ctx.createLinearGradient(obs.x, obs.y, obs.x, obs.y + obs.height);
        grad.addColorStop(0, "#ffd9fb");
        grad.addColorStop(1, "#c400a0");
        ctx.fillStyle = grad;
        spikesPath(obs);
        ctx.fill();
      } else {
        const grad = ctx.createLinearGradient(obs.x, obs.y, obs.x + obs.width, obs.y + obs.height);
        grad.addColorStop(0, "#ffcdf6");
        grad.addColorStop(1, "#b3009e");
        ctx.fillStyle = grad;
        crystalPath(obs);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    drawSky();
    drawParallaxLayer(FAR_LAYER, false);
    drawParallaxLayer(NEAR_LAYER, true);
    drawGround();
    drawObstacles();
    drawPlayer();

    if (gameOver) {
      ctx.fillStyle = "rgba(15, 12, 41, 0.55)";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "#f4f4fb";
      ctx.font = "bold 32px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Game Over", WIDTH / 2, HEIGHT / 2 - 9);
      ctx.font = "20px 'Segoe UI', Arial, sans-serif";
      ctx.fillText("Press Restart or Space to try again", WIDTH / 2, HEIGHT / 2 + 27);
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
  }

  // --- Input handling ---
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp") {
      e.preventDefault();
      if (gameOver) {
        start();
      } else {
        jump();
      }
    } else if (e.code === "ArrowDown") {
      e.preventDefault();
      setDuck(true);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "ArrowDown") {
      setDuck(false);
    }
  });

  canvas.addEventListener("pointerdown", () => {
    if (gameOver) {
      start();
    } else {
      jump();
    }
  });

  restartBtn.addEventListener("click", () => {
    start();
  });

  updateHud();
  start();
})();
