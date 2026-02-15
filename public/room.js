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

function bump(el, cls, ms = 650) {
  if (!el) return;
  el.classList.remove(cls);
  // Reflow to restart animation reliably
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

function countLines(board, calledSet) {
  const size = board.length;
  let lines = 0;
  for (let r = 0; r < size; r++) {
    let ok = true;
    for (let c = 0; c < size; c++) if (!calledSet.has(board[r][c])) ok = false;
    if (ok) lines++;
  }
  for (let c = 0; c < size; c++) {
    let ok = true;
    for (let r = 0; r < size; r++) if (!calledSet.has(board[r][c])) ok = false;
    if (ok) lines++;
  }
  {
    let ok = true;
    for (let i = 0; i < size; i++) if (!calledSet.has(board[i][i])) ok = false;
    if (ok) lines++;
  }
  {
    let ok = true;
    for (let i = 0; i < size; i++) if (!calledSet.has(board[i][size - 1 - i])) ok = false;
    if (ok) lines++;
  }
  return lines;
}

function statusLabel(status) {
  if (status === "lobby") return "대기중";
  if (status === "playing") return "진행중";
  if (status === "ended") return "종료";
  return status;
}

function renderPlayers(room) {
  const list = $("players");
  list.innerHTML = "";
  const players = [...room.players].sort((a, b) => a.username.localeCompare(b.username));
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "player";

    const left = document.createElement("div");
    left.className = "name";
    left.textContent = p.username + (p.userId === room.hostUserId ? " (방장)" : "");

    const right = document.createElement("div");
    right.className = "meta";

    const dot = document.createElement("span");
    dot.className = "dot" + (p.online ? " on" : "");
    const st = document.createElement("span");
    st.textContent = p.online ? "online" : "offline";
    right.append(dot, st);

    row.append(left, right);
    list.append(row);
  }
}

function buildBoard(board) {
  const size = board.length;
  const el = $("board");
  el.innerHTML = "";
  el.style.gridTemplateColumns = `repeat(${size}, minmax(0, 1fr))`;

  const flat = board.flat();
  for (const num of flat) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.num = String(num);
    cell.textContent = String(num);
    el.append(cell);
  }
}

function updateBoardMarks(board, room) {
  const called = new Set(room.calledNumbers || []);
  const last = room.lastNumber;
  const cells = $("board").querySelectorAll(".cell");
  let lastCell = null;
  for (const cell of cells) {
    const n = Number(cell.dataset.num);
    const isMarked = called.has(n);
    cell.classList.toggle("marked", isMarked);
    const isLast = last != null && n === last;
    cell.classList.toggle("last", isLast);
    if (isLast) lastCell = cell;
  }
  if (lastCell) bump(lastCell, "hit", 520);
  $("myLines").textContent = String(countLines(board, called));
}

function renderBanner(me, room) {
  const el = $("banner");
  el.textContent = "";
  el.className = "";
  document.body.classList.remove("celebrate");

  if (room.status === "ended" && Array.isArray(room.winners) && room.winners.length > 0) {
    const names = room.winners.map((w) => w.username).join(", ");
    const meWin = room.winners.some((w) => w.userId === me.userId);
    el.textContent = `빙고! 승자: ${names}`;
    el.className = "banner " + (meWin ? "good" : "");
    if (meWin) document.body.classList.add("celebrate");
  } else if (room.status === "ended") {
    el.textContent = "게임 종료 (승자 없음)";
    el.className = "banner";
  }
}

window.initRoomPage = async function initRoomPage() {
  const code = decodeURIComponent(location.pathname.split("/").pop() || "").toUpperCase();
  $("code").textContent = code;

  const meRes = await apiJson("/api/me");
  if (!meRes.data?.user) {
    location.href = "/login";
    return;
  }
  const me = meRes.data.user;
  $("me").textContent = me.username;

  $("leave").addEventListener("click", async () => {
    await apiJson(`/api/rooms/${encodeURIComponent(code)}/leave`, { method: "POST" });
    location.href = "/lobby";
  });

  let board = null;
  let roomState = null;
  let prevLastNumber = null;
  let countdownTimer = null;

  const join = await apiJson(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST" });
  if (!join.ok || !join.data?.ok) {
    const err = join.data?.error || "unknown";
    $("error").textContent =
      err === "room_full"
        ? "방이 가득 찼습니다. (최대 8명)"
        : err === "room_not_joinable"
          ? "이미 시작된 방입니다. (대기중일 때만 참가 가능)"
          : "방에 참가할 수 없습니다.";
    return;
  }

  board = join.data.board;
  roomState = join.data.room;
  prevLastNumber = roomState.lastNumber;
  buildBoard(board);

  function playerNameById(room, userId) {
    const found = room.players.find((p) => p.userId === userId);
    return found ? found.username : "알 수 없음";
  }

  function remainingNumbers(room) {
    const max = room.size * room.size;
    const called = new Set(room.calledNumbers || []);
    const out = [];
    for (let n = 1; n <= max; n++) {
      if (!called.has(n)) out.push(n);
    }
    return out;
  }

  function renderPickNumbers(room) {
    const select = $("pickNumber");
    const prev = Number(select.value);
    const left = remainingNumbers(room);
    select.innerHTML = "";
    for (const n of left) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      select.append(opt);
    }
    if (left.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "-";
      select.append(opt);
      select.value = "";
      return;
    }
    if (left.includes(prev)) select.value = String(prev);
    else select.value = String(left[0]);
  }

  function updateTurnCountdown(room) {
    if (room.status !== "playing" || !room.turnEndsAt) {
      $("turnCountdown").textContent = "-";
      return;
    }
    const remainMs = Number(room.turnEndsAt) - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
    $("turnCountdown").textContent = String(remainSec);
  }

  function renderTurnNotice(room) {
    const isMyTurn = room.status === "playing" && room.turnUserId === me.userId;
    const turnEl = $("turnNotice");
    turnEl.className = "banner";

    if (room.status === "lobby") {
      turnEl.textContent = "게임 시작을 기다리는 중";
      return;
    }
    if (room.status === "ended") {
      turnEl.textContent = "게임이 종료되었습니다.";
      return;
    }

    if (!room.turnUserId) {
      turnEl.textContent = "차례를 계산 중입니다.";
      return;
    }

    const turnName = playerNameById(room, room.turnUserId);
    if (isMyTurn) {
      turnEl.textContent = "지금 당신 차례입니다. 원하는 번호를 고르세요!";
      turnEl.className = "banner good";
    } else {
      turnEl.textContent = `지금 ${turnName}님 차례입니다.`;
    }
  }

  function applyState(room) {
    roomState = room;
    $("status").textContent = statusLabel(room.status);
    $("size").textContent = `${room.size}x${room.size}`;
    $("targetLines").textContent = String(room.targetLines || 5);
    $("turnLimit").textContent = String(room.drawTimeoutSeconds || 10);
    $("drawTimeout").value = String(room.drawTimeoutSeconds || 10);
    $("lastNumber").textContent = room.lastNumber == null ? "-" : String(room.lastNumber);
    if (room.lastNumber != null && room.lastNumber !== prevLastNumber) {
      bump($("lastNumber"), "bump", 720);
      prevLastNumber = room.lastNumber;
    }

    renderPlayers(room);
    updateBoardMarks(board, room);
    renderPickNumbers(room);
    renderBanner(me, room);
    renderTurnNotice(room);
    updateTurnCountdown(room);

    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => updateTurnCountdown(roomState), 250);

    const isHost = me.userId === room.hostUserId;
    $("hostControls").style.display = isHost ? "flex" : "none";

    $("start").disabled = room.status !== "lobby";
    $("drawTimeout").disabled = room.status !== "lobby";

    const canDraw = room.status === "playing" && room.turnUserId === me.userId;
    $("draw").disabled = !canDraw;
    $("pickNumber").disabled = !canDraw;
  }

  $("start").addEventListener("click", async () => {
    const drawTimeoutSeconds = Number($("drawTimeout").value);
    const r = await apiJson(`/api/rooms/${encodeURIComponent(code)}/start`, {
      method: "POST",
      body: { drawTimeoutSeconds },
    });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "invalid_draw_timeout_seconds") alert("제한시간은 3/5/7/10/15/20초만 가능합니다.");
      else alert("시작 실패 (방장만 가능)");
    }
  });

  $("draw").addEventListener("click", async () => {
    const selected = Number($("pickNumber").value);
    const r = await apiJson(`/api/rooms/${encodeURIComponent(code)}/draw`, {
      method: "POST",
      body: { number: selected },
    });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "not_your_turn") alert("아직 내 차례가 아닙니다.");
      else if (err === "invalid_number") alert("선택 가능한 번호를 골라주세요.");
      else if (err === "number_already_called") alert("이미 뽑힌 번호입니다. 다른 번호를 고르세요.");
      else alert("번호 뽑기 실패");
    }
  });

  applyState(roomState);

  const es = new EventSource(`/sse/room/${encodeURIComponent(code)}`);
  es.addEventListener("state", (ev) => {
    const data = JSON.parse(ev.data);
    applyState(data);
  });
  es.onerror = () => {
    $("net").textContent = "연결이 불안정합니다. (자동 재연결 시도중)";
    $("net").className = "muted";
  };
};
