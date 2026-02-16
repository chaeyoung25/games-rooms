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

const SIZE = 15;

function setMsg(text, kind = "") {
  const el = $("gomokuMsg");
  el.textContent = text || "";
  el.className = `status-msg ${kind}`.trim();
}

function makeBoard() {
  return Array.from({ length: SIZE * SIZE }, () => null);
}

function stoneLabel(stone) {
  if (stone === "B") return "흑(B)";
  if (stone === "W") return "백(W)";
  return "-";
}

function countDir(board, row, col, dr, dc, stone) {
  let c = 0;
  let r = row + dr;
  let k = col + dc;
  while (r >= 0 && r < SIZE && k >= 0 && k < SIZE) {
    if (board[r * SIZE + k] !== stone) break;
    c += 1;
    r += dr;
    k += dc;
  }
  return c;
}

function hasFive(board, index, stone) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const a = countDir(board, row, col, dr, dc, stone);
    const b = countDir(board, row, col, -dr, -dc, stone);
    if (1 + a + b >= 5) return true;
  }
  return false;
}

function centerScore(index) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  const mid = Math.floor(SIZE / 2);
  return 20 - (Math.abs(row - mid) + Math.abs(col - mid));
}

function evalMove(board, index, stone) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  let score = centerScore(index);
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const a = countDir(board, row, col, dr, dc, stone);
    const b = countDir(board, row, col, -dr, -dc, stone);
    const len = a + b;
    score += len * len * 6;
  }
  return score;
}

function chooseBotMove(board) {
  const empties = [];
  for (let i = 0; i < board.length; i++) {
    if (!board[i]) empties.push(i);
  }
  if (empties.length === 0) return null;

  for (const idx of empties) {
    board[idx] = "W";
    const win = hasFive(board, idx, "W");
    board[idx] = null;
    if (win) return idx;
  }

  for (const idx of empties) {
    board[idx] = "B";
    const playerWin = hasFive(board, idx, "B");
    board[idx] = null;
    if (playerWin) return idx;
  }

  const center = Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2);
  if (!board[center]) return center;

  let best = [];
  let bestScore = -Infinity;
  for (const idx of empties) {
    const score = evalMove(board, idx, "W") + evalMove(board, idx, "B") * 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = [idx];
    } else if (score === bestScore) {
      best.push(idx);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}

window.initGomokuPage = async function initGomokuPage() {
  const meRes = await apiJson("/api/me");
  if (!meRes.data?.user) {
    location.href = "/login";
    return;
  }
  const me = meRes.data.user;
  $("me").textContent = me.username;

  $("logout").addEventListener("click", async () => {
    await apiJson("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  let mode = "bot";
  let roomCode = "";
  let roomState = null;
  let es = null;
  let botTimer = null;

  const botState = {
    board: makeBoard(),
    turn: "B",
    status: "playing",
    winner: null,
    draw: false,
    lastMoveIndex: null,
  };

  function clearBotTimer() {
    if (botTimer) {
      clearTimeout(botTimer);
      botTimer = null;
    }
  }

  function closeStream() {
    if (!es) return;
    es.close();
    es = null;
  }

  function playerStoneInRoom(state) {
    if (!state) return null;
    const p = state.players.find((x) => x.userId === me.userId);
    return p ? p.stone : null;
  }

  function renderPlayers() {
    const wrap = $("gomokuPlayers");
    wrap.innerHTML = "";

    if (mode === "bot") {
      const rows = [
        { name: `${me.username} (YOU)`, stone: "B", online: true },
        { name: "COM", stone: "W", online: true },
      ];
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "player";
        const left = document.createElement("div");
        left.className = "name";
        left.textContent = `${r.name} · ${stoneLabel(r.stone)}`;
        const right = document.createElement("div");
        right.className = "meta";
        const dot = document.createElement("span");
        dot.className = "dot on";
        right.append(dot);
        row.append(left, right);
        wrap.append(row);
      }
      return;
    }

    if (!roomState) return;
    const list = [...roomState.players];
    for (const p of list) {
      const row = document.createElement("div");
      row.className = "player";
      const left = document.createElement("div");
      left.className = "name";
      let label = `${p.username} · ${stoneLabel(p.stone)}`;
      if (p.userId === roomState.hostUserId) label += " (방장)";
      if (roomState.status === "playing" && p.userId === roomState.turnUserId) label += " · 현재 차례";
      left.textContent = label;
      const right = document.createElement("div");
      right.className = "meta";
      const dot = document.createElement("span");
      dot.className = "dot" + (p.online ? " on" : "");
      right.append(dot);
      row.append(left, right);
      wrap.append(row);
    }
  }

  function updateStatusText(text) {
    $("gomokuStatus").textContent = text;
  }

  function renderTurnBanner() {
    const el = $("gomokuTurn");
    el.className = "banner";

    if (mode === "bot") {
      if (botState.status === "ended") {
        if (botState.draw) {
          el.textContent = "무승부입니다.";
        } else if (botState.winner === "B") {
          el.className = "banner good";
          el.textContent = "승리! 5목 완성";
        } else {
          el.textContent = "컴퓨터 승리. 다시 도전해보세요.";
        }
        return;
      }
      if (botState.turn === "B") {
        el.className = "banner good";
        el.textContent = "당신 차례입니다. 빈 칸을 선택하세요.";
      } else {
        el.textContent = "컴퓨터가 생각 중입니다...";
      }
      return;
    }

    if (!roomState) {
      el.textContent = "1:1 온라인 모드: 방을 만들거나 참가하세요.";
      return;
    }
    if (roomState.status === "lobby") {
      el.textContent = "대기중: 2명이 모이면 방장이 대국 시작";
      return;
    }
    if (roomState.status === "ended") {
      if (roomState.draw) {
        el.textContent = "대국 종료 · 무승부";
      } else {
        el.textContent = `대국 종료 · 승자 ${roomState.winnerUsername || "-"} (${stoneLabel(roomState.winnerStone)})`;
      }
      return;
    }

    if (roomState.turnUserId === me.userId) {
      el.className = "banner good";
      el.textContent = "내 차례입니다. 놓을 칸을 선택하세요.";
    } else {
      const now = roomState.players.find((p) => p.userId === roomState.turnUserId);
      el.textContent = `상대 차례: ${now ? now.username : "알 수 없음"}`;
    }
  }

  async function onCellClick(index) {
    if (mode === "bot") {
      if (botState.status !== "playing" || botState.turn !== "B") return;
      if (botState.board[index]) return;
      botState.board[index] = "B";
      botState.lastMoveIndex = index;
      if (hasFive(botState.board, index, "B")) {
        botState.status = "ended";
        botState.winner = "B";
        updateStatusText("종료");
        renderBoard();
        renderTurnBanner();
        return;
      }
      if (botState.board.every((v) => Boolean(v))) {
        botState.status = "ended";
        botState.draw = true;
        updateStatusText("종료");
        renderBoard();
        renderTurnBanner();
        return;
      }
      botState.turn = "W";
      updateStatusText("진행중");
      renderBoard();
      renderTurnBanner();

      clearBotTimer();
      botTimer = setTimeout(() => {
        const idx = chooseBotMove(botState.board);
        if (idx == null || botState.status !== "playing") return;
        botState.board[idx] = "W";
        botState.lastMoveIndex = idx;
        if (hasFive(botState.board, idx, "W")) {
          botState.status = "ended";
          botState.winner = "W";
          updateStatusText("종료");
          renderBoard();
          renderTurnBanner();
          return;
        }
        if (botState.board.every((v) => Boolean(v))) {
          botState.status = "ended";
          botState.draw = true;
          updateStatusText("종료");
          renderBoard();
          renderTurnBanner();
          return;
        }
        botState.turn = "B";
        renderBoard();
        renderTurnBanner();
      }, 540);
      return;
    }

    if (!roomCode || !roomState) return;
    if (roomState.status !== "playing") return;
    if (roomState.turnUserId !== me.userId) return;
    if (roomState.board[index]) return;

    const r = await apiJson(`/api/gomoku/rooms/${encodeURIComponent(roomCode)}/move`, {
      method: "POST",
      body: { index },
    });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "not_your_turn") setMsg("아직 내 차례가 아닙니다.", "error");
      else if (err === "occupied") setMsg("이미 놓인 자리입니다.", "error");
      else setMsg("착수 실패", "error");
    }
  }

  function renderBoard() {
    const boardEl = $("gomokuBoard");
    boardEl.innerHTML = "";

    const board = mode === "bot" ? botState.board : roomState ? roomState.board : makeBoard();
    const canPlayBot = mode === "bot" && botState.status === "playing" && botState.turn === "B";
    const canPlayPvp = mode === "pvp" && roomState && roomState.status === "playing" && roomState.turnUserId === me.userId;
    const lastIndex = mode === "bot" ? botState.lastMoveIndex : roomState ? roomState.lastMoveIndex : null;

    for (let i = 0; i < SIZE * SIZE; i++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "gomoku-cell";
      if (lastIndex === i) cell.classList.add("last");

      const v = board[i];
      if (v) {
        cell.disabled = true;
        const stone = document.createElement("span");
        stone.className = `gomoku-stone ${v === "B" ? "black" : "white"}`;
        cell.append(stone);
      } else {
        cell.disabled = !(canPlayBot || canPlayPvp);
      }

      cell.addEventListener("click", () => onCellClick(i));
      boardEl.append(cell);
    }
  }

  function resetBotGame() {
    clearBotTimer();
    botState.board = makeBoard();
    botState.turn = "B";
    botState.status = "playing";
    botState.winner = null;
    botState.draw = false;
    botState.lastMoveIndex = null;
    $("gomokuMyStone").textContent = stoneLabel("B");
    updateStatusText("진행중");
    setMsg("컴퓨터 대전을 시작합니다.", "ok");
    renderPlayers();
    renderTurnBanner();
    renderBoard();
  }

  function applyRoomState(state) {
    roomState = state;
    roomCode = state.code;
    $("gomokuCode").value = state.code;

    const myStone = playerStoneInRoom(state);
    $("gomokuMyStone").textContent = stoneLabel(myStone);
    updateStatusText(state.status === "lobby" ? "대기" : state.status === "playing" ? "진행중" : "종료");

    const isHost = state.hostUserId === me.userId;
    $("startGomoku").style.display = isHost ? "inline-flex" : "none";
    $("startGomoku").disabled = state.status !== "lobby" || state.players.length !== 2;

    renderPlayers();
    renderTurnBanner();
    renderBoard();
  }

  function resetPvpState() {
    roomCode = "";
    roomState = null;
    $("gomokuCode").value = "";
    $("gomokuMyStone").textContent = "-";
    updateStatusText("대기");
    $("startGomoku").style.display = "none";
    renderPlayers();
    renderTurnBanner();
    renderBoard();
  }

  function openStream(code) {
    closeStream();
    es = new EventSource(`/sse/gomoku/${encodeURIComponent(code)}`);
    es.addEventListener("state", (ev) => {
      const state = JSON.parse(ev.data);
      applyRoomState(state);
    });
    es.onerror = () => setMsg("연결이 불안정합니다. 자동 재연결 중...", "muted");
  }

  async function leaveCurrentPvp(silent = false) {
    if (!roomCode) return;
    await apiJson(`/api/gomoku/rooms/${encodeURIComponent(roomCode)}/leave`, { method: "POST" });
    closeStream();
    resetPvpState();
    if (!silent) setMsg("오목방에서 나왔습니다.", "ok");
  }

  async function joinPvpRoom(code) {
    const r = await apiJson(`/api/gomoku/rooms/${encodeURIComponent(code)}/join`, { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "room_not_found") setMsg("방을 찾을 수 없습니다.", "error");
      else if (err === "room_full") setMsg("이미 2명이 참가중입니다.", "error");
      else if (err === "room_not_joinable") setMsg("이미 진행 중인 방입니다.", "error");
      else setMsg("방 참가 실패", "error");
      return;
    }
    applyRoomState(r.data.room);
    openStream(code);
    setMsg("오목방 참가 완료", "ok");
  }

  async function setMode(nextMode) {
    if (mode === nextMode) return;
    if (mode === "pvp") {
      await leaveCurrentPvp(true);
    }
    mode = nextMode;

    const pvp = mode === "pvp";
    $("gomokuPvpControls").style.display = pvp ? "flex" : "none";
    $("newBotGame").style.display = pvp ? "none" : "inline-flex";
    if (!pvp) $("startGomoku").style.display = "none";

    if (pvp) {
      setMsg("1:1 온라인 모드입니다. 방을 만들거나 참가하세요.", "muted");
      resetPvpState();
    } else {
      resetBotGame();
    }
  }

  $("gomokuMode").addEventListener("change", async (e) => {
    await setMode(String(e.target.value || "bot"));
  });

  $("newBotGame").addEventListener("click", resetBotGame);

  $("createGomoku").addEventListener("click", async () => {
    if (mode !== "pvp") return;
    const r = await apiJson("/api/gomoku/rooms", { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      setMsg("방 생성 실패", "error");
      return;
    }
    await joinPvpRoom(r.data.code);
  });

  $("joinGomoku").addEventListener("click", async () => {
    if (mode !== "pvp") return;
    const code = String($("gomokuCode").value || "").trim().toUpperCase();
    if (!code) {
      setMsg("방 코드를 입력하세요.", "error");
      return;
    }
    if (roomCode && roomCode !== code) {
      await leaveCurrentPvp(true);
    }
    await joinPvpRoom(code);
  });

  $("leaveGomoku").addEventListener("click", async () => {
    if (mode !== "pvp") return;
    await leaveCurrentPvp(false);
  });

  $("startGomoku").addEventListener("click", async () => {
    if (!roomCode || mode !== "pvp") return;
    const r = await apiJson(`/api/gomoku/rooms/${encodeURIComponent(roomCode)}/start`, { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "need_two_players") setMsg("2명이 참가해야 시작할 수 있습니다.", "error");
      else if (err === "host_only") setMsg("방장만 시작할 수 있습니다.", "error");
      else setMsg("대국 시작 실패", "error");
      return;
    }
    setMsg("대국 시작", "ok");
  });

  resetBotGame();
};
