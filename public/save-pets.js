async function apiJson(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function $(id) {
  return document.getElementById(id);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ax = px - x1;
    const ay = py - y1;
    return Math.hypot(ax, ay);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

window.initSavePetsPage = async function initSavePetsPage() {
  const meRes = await apiJson("/api/me");
  if (!meRes.data?.user) {
    location.href = "/login";
    return;
  }
  $("me").textContent = meRes.data.user.username;

  $("logout").addEventListener("click", async () => {
    await apiJson("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  const canvas = $("savePetsCanvas");
  const ctx = canvas.getContext("2d");

  const state = {
    level: 1,
    lines: [],
    currentLine: [],
    drawing: false,
    roundStarted: false,
    alive: true,
    win: false,
    bees: [],
    startTime: 0,
    surviveMs: 8000,
    pet: { x: 0, y: 0, r: 26 },
    hive: { x: 0, y: 0, r: 24 },
    timer: null,
  };

  function setMsg(text, kind = "") {
    const el = $("savePetsMsg");
    el.textContent = text || "";
    el.className = `status-msg ${kind}`.trim();
  }

  function setRemain(ms) {
    const sec = Math.max(0, ms / 1000);
    $("savePetsRemain").textContent = `${sec.toFixed(1)}s`;
  }

  function updateHud() {
    $("savePetsLevel").textContent = String(state.level);
  }

  function resizeCanvas() {
    const box = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.max(280, Math.floor(box.width));
    const h = Math.max(320, Math.floor(w * 0.62));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    state.pet.x = w * 0.5;
    state.pet.y = h * 0.67;
    state.hive.x = w * 0.5;
    state.hive.y = h * 0.16;
  }

  function randomBee(i, count) {
    const spread = 90;
    const x = state.hive.x + (i - (count - 1) / 2) * (spread / Math.max(1, count - 1));
    const y = state.hive.y + 4;
    const vx = (Math.random() - 0.5) * 1.2;
    const vy = 0.6 + Math.random() * 0.8;
    return { x, y, vx, vy, r: 8 };
  }

  function resetRound(keepLevel) {
    state.lines = [];
    state.currentLine = [];
    state.drawing = false;
    state.roundStarted = false;
    state.alive = true;
    state.win = false;
    if (!keepLevel) state.level = 1;

    const beeCount = Math.min(18, 4 + state.level * 2);
    state.bees = Array.from({ length: beeCount }, (_, i) => randomBee(i, beeCount));

    state.startTime = 0;
    state.surviveMs = Math.max(5000, 8000 - Math.min(2500, state.level * 220));
    setRemain(state.surviveMs);
    updateHud();
    setMsg("선을 한 번 그려서 반려동물을 보호하세요.", "muted");
  }

  function canvasPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function startDraw(ev) {
    if (state.roundStarted || !state.alive || state.win) return;
    state.drawing = true;
    state.currentLine = [];
    const p = canvasPoint(ev);
    state.currentLine.push(p);
  }

  function moveDraw(ev) {
    if (!state.drawing) return;
    const p = canvasPoint(ev);
    const last = state.currentLine[state.currentLine.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 4) {
      state.currentLine.push(p);
    }
  }

  function endDraw() {
    if (!state.drawing) return;
    state.drawing = false;
    if (state.currentLine.length >= 2) {
      state.lines.push(state.currentLine.slice());
      state.roundStarted = true;
      state.startTime = performance.now();
      setMsg("벌이 공격합니다. 끝까지 버티세요!", "ok");
    } else {
      state.currentLine = [];
    }
  }

  function beeHitsLine(bee) {
    for (const line of state.lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        const d = distanceToSegment(bee.x, bee.y, a.x, a.y, b.x, b.y);
        if (d <= bee.r + 3) {
          return { a, b };
        }
      }
    }
    return null;
  }

  function updateBees(dt) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    for (const bee of state.bees) {
      const ax = state.pet.x - bee.x;
      const ay = state.pet.y - bee.y;
      const len = Math.hypot(ax, ay) || 1;
      bee.vx += (ax / len) * 0.05;
      bee.vy += (ay / len) * 0.05;

      const speed = Math.hypot(bee.vx, bee.vy);
      const maxSpeed = 2.8 + Math.min(1.2, state.level * 0.08);
      if (speed > maxSpeed) {
        bee.vx = (bee.vx / speed) * maxSpeed;
        bee.vy = (bee.vy / speed) * maxSpeed;
      }

      bee.x += bee.vx * dt;
      bee.y += bee.vy * dt;

      if (bee.x < bee.r) {
        bee.x = bee.r;
        bee.vx = Math.abs(bee.vx) * 0.9;
      }
      if (bee.x > w - bee.r) {
        bee.x = w - bee.r;
        bee.vx = -Math.abs(bee.vx) * 0.9;
      }
      if (bee.y < bee.r) {
        bee.y = bee.r;
        bee.vy = Math.abs(bee.vy) * 0.9;
      }
      if (bee.y > h - bee.r) {
        bee.y = h - bee.r;
        bee.vy = -Math.abs(bee.vy) * 0.9;
      }

      const hit = beeHitsLine(bee);
      if (hit) {
        const sx = hit.b.x - hit.a.x;
        const sy = hit.b.y - hit.a.y;
        const sl = Math.hypot(sx, sy) || 1;
        const nx = -sy / sl;
        const ny = sx / sl;
        const dot = bee.vx * nx + bee.vy * ny;
        bee.vx = bee.vx - 2 * dot * nx;
        bee.vy = bee.vy - 2 * dot * ny;
        bee.x += nx * 2;
        bee.y += ny * 2;
      }

      if (Math.hypot(bee.x - state.pet.x, bee.y - state.pet.y) <= bee.r + state.pet.r - 1) {
        state.alive = false;
        state.roundStarted = false;
        setMsg("실패! 벌이 반려동물을 공격했습니다.", "error");
        break;
      }
    }
  }

  function drawPet() {
    const { x, y, r } = state.pet;
    ctx.fillStyle = "#fff4dc";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f5ddb1";
    ctx.beginPath();
    ctx.ellipse(x - r * 0.55, y - r * 0.88, 9, 14, -0.4, 0, Math.PI * 2);
    ctx.ellipse(x + r * 0.55, y - r * 0.88, 9, 14, 0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1f1f1f";
    ctx.beginPath();
    ctx.arc(x - 8, y - 3, 2.4, 0, Math.PI * 2);
    ctx.arc(x + 8, y - 3, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#f58d9b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y + 5, 5, 0.1, Math.PI - 0.1);
    ctx.stroke();
  }

  function drawHive() {
    const { x, y, r } = state.hive;
    ctx.fillStyle = "#f0b74d";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#996015";
    ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.9, y + i * 5);
      ctx.lineTo(x + r * 0.9, y + i * 5);
      ctx.stroke();
    }
  }

  function drawLines() {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#3b5dd8";
    ctx.lineWidth = 8;

    for (const line of state.lines) {
      ctx.beginPath();
      ctx.moveTo(line[0].x, line[0].y);
      for (let i = 1; i < line.length; i++) {
        ctx.lineTo(line[i].x, line[i].y);
      }
      ctx.stroke();
    }

    if (state.drawing && state.currentLine.length > 1) {
      const line = state.currentLine;
      ctx.strokeStyle = "#4f71f0";
      ctx.beginPath();
      ctx.moveTo(line[0].x, line[0].y);
      for (let i = 1; i < line.length; i++) {
        ctx.lineTo(line[i].x, line[i].y);
      }
      ctx.stroke();
    }
  }

  function drawBees() {
    for (const bee of state.bees) {
      ctx.fillStyle = "#ffd94f";
      ctx.beginPath();
      ctx.arc(bee.x, bee.y, bee.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#1d1d1d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bee.x - bee.r + 2, bee.y - 2);
      ctx.lineTo(bee.x + bee.r - 2, bee.y - 2);
      ctx.moveTo(bee.x - bee.r + 2, bee.y + 2);
      ctx.lineTo(bee.x + bee.r - 2, bee.y + 2);
      ctx.stroke();
    }
  }

  let prev = performance.now();
  function tick(now) {
    const dt = Math.min(1.8, (now - prev) / 16.666);
    prev = now;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#f8f4eb");
    grad.addColorStop(1, "#f0dbb8");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    if (state.roundStarted && state.alive) {
      updateBees(dt);
      const elapsed = now - state.startTime;
      const remain = state.surviveMs - elapsed;
      setRemain(remain);
      if (remain <= 0) {
        state.roundStarted = false;
        state.win = true;
        state.level += 1;
        setMsg("성공! 다음 레벨로 올라갑니다.", "ok");
      }
    }

    drawHive();
    drawLines();
    drawPet();
    drawBees();

    if (state.win) {
      ctx.fillStyle = "rgba(35, 134, 76, 0.14)";
      ctx.fillRect(0, 0, w, h);
    } else if (!state.alive) {
      ctx.fillStyle = "rgba(171, 56, 68, 0.14)";
      ctx.fillRect(0, 0, w, h);
    }

    if (state.win) {
      state.win = false;
      setTimeout(() => {
        resetRound(true);
      }, 550);
    }

    requestAnimationFrame(tick);
  }

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    startDraw(ev);
  });
  canvas.addEventListener("pointermove", moveDraw);
  canvas.addEventListener("pointerup", endDraw);
  canvas.addEventListener("pointercancel", endDraw);
  canvas.addEventListener("pointerleave", () => {
    if (state.drawing) endDraw();
  });

  $("newSavePets").addEventListener("click", () => resetRound(true));
  $("resetSavePets").addEventListener("click", () => resetRound(false));

  window.addEventListener("resize", resizeCanvas);

  resizeCanvas();
  resetRound(false);
  requestAnimationFrame(tick);
};
