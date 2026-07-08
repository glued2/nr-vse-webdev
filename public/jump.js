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
  // we just draw in these coordinates.
  const WIDTH = canvas.width; // 600
  const HEIGHT = canvas.height; // 220
  const GROUND_Y = HEIGHT - 30;

  const PLAYER_X = 70;
  const PLAYER_SIZE = 26;
  const DUCK_HEIGHT = 14;

  const GRAVITY = 2200; // px/s^2
  const JUMP_VELOCITY = -640; // px/s

  const BASE_SPEED = 220; // px/s
  const MAX_SPEED = 560;
  const SPEED_RAMP = 6; // px/s per second survived

  let player, obstacles, speed, distance, score, elapsed, running, gameOver, lastTime, spawnTimer, spawnGap, rafId;

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

  function playerTop() {
    return GROUND_Y - playerHeight();
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
    // Occasionally spawn a taller obstacle, or a low "flying" one that
    // requires ducking, to keep things interesting.
    const roll = Math.random();
    let width, height, y, kind;
    if (roll < 0.15) {
      // Low flying obstacle — must duck under it.
      kind = "fly";
      width = 30;
      height = 16;
      y = GROUND_Y - PLAYER_SIZE - 6;
    } else if (roll < 0.35) {
      kind = "tall";
      width = 22;
      height = 44;
      y = GROUND_Y - height;
    } else {
      kind = "block";
      width = 20 + Math.random() * 12;
      height = 26 + Math.random() * 14;
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
      if (player.y >= GROUND_Y - PLAYER_SIZE) {
        player.y = GROUND_Y - PLAYER_SIZE;
        player.vy = 0;
        player.onGround = true;
      }
    } else {
      player.y = GROUND_Y - PLAYER_SIZE;
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

    // Collision detection against the player's current hitbox.
    const pTop = playerTop();
    const pHeight = playerHeight();
    for (const obs of obstacles) {
      if (rectsOverlap(PLAYER_X, pTop, PLAYER_SIZE, pHeight, obs.x, obs.y, obs.width, obs.height)) {
        endGame();
        break;
      }
    }

    updateHud();
  }

  function drawBackground() {
    // Themed "sky" gradient using the site's accent colors, plus a ground line.
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, "rgba(0, 229, 255, 0.10)");
    sky.addColorStop(1, "rgba(255, 47, 212, 0.05)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, GROUND_Y);

    ctx.fillStyle = "rgba(15, 12, 41, 1)";
    ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(WIDTH, GROUND_Y);
    ctx.stroke();
  }

  function drawPlayer() {
    const top = playerTop();
    const h = playerHeight();
    ctx.save();
    ctx.shadowColor = "#00e5ff";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#00e5ff";
    ctx.fillRect(PLAYER_X, top, PLAYER_SIZE, h);
    ctx.restore();
  }

  function drawObstacles() {
    ctx.save();
    ctx.shadowColor = "#ff2fd4";
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#ff2fd4";
    for (const obs of obstacles) {
      ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    drawBackground();
    drawObstacles();
    drawPlayer();

    if (gameOver) {
      ctx.fillStyle = "rgba(15, 12, 41, 0.55)";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "#f4f4fb";
      ctx.font = "bold 22px 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Game Over", WIDTH / 2, HEIGHT / 2 - 6);
      ctx.font = "14px 'Segoe UI', Arial, sans-serif";
      ctx.fillText("Press Restart or Space to try again", WIDTH / 2, HEIGHT / 2 + 18);
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
