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

function setMsg(text, kind = "") {
  const el = $("memoryMsg");
  el.textContent = text || "";
  el.className = `status-msg ${kind}`.trim();
}

function columnsForCount(cardCount) {
  if (cardCount <= 20) return 5;
  if (cardCount <= 30) return 6;
  if (cardCount <= 40) return 8;
  return 10;
}

window.initMemoryPage = async function initMemoryPage() {
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

  let roomCode = "";
  let roomState = null;
  let es = null;

  function closeStream() {
    if (!es) return;
    es.close();
    es = null;
  }

  function openStream(code) {
    closeStream();
    es = new EventSource(`/sse/memory/${encodeURIComponent(code)}`);
    es.addEventListener("state", (ev) => {
      const state = JSON.parse(ev.data);
      applyState(state);
    });
    es.onerror = () => setMsg("연결이 불안정합니다. 자동 재연결 중...", "muted");
  }

  function renderPlayers(state) {
    const wrap = $("memoryPlayers");
    wrap.innerHTML = "";
    const players = [...state.players].sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
    for (const p of players) {
      const row = document.createElement("div");
      row.className = "player";

      const left = document.createElement("div");
      left.className = "name";
      let label = p.username;
      if (p.userId === state.hostUserId) label += " (방장)";
      if (p.userId === state.turnUserId && state.status === "playing") label += " · 현재 차례";
      left.textContent = label;

      const right = document.createElement("div");
      right.className = "meta";
      const dot = document.createElement("span");
      dot.className = "dot" + (p.online ? " on" : "");
      const score = document.createElement("span");
      score.textContent = `${p.score}점`;
      right.append(dot, score);

      row.append(left, right);
      wrap.append(row);
    }
  }

  function renderTurn(state) {
    const el = $("memoryTurn");
    if (!state) {
      el.className = "banner";
      el.textContent = "방을 만들거나 참가하세요.";
      return;
    }
    if (state.status === "lobby") {
      el.className = "banner";
      el.textContent = "대기중: 방장이 게임 시작을 누르면 시작됩니다.";
      return;
    }
    if (state.status === "ended") {
      el.className = "banner";
      if (Array.isArray(state.winners) && state.winners.length > 0) {
        const names = state.winners.map((w) => `${w.username}(${w.score})`).join(", ");
        el.textContent = `게임 종료 · 우승: ${names}`;
      } else {
        el.textContent = "게임 종료";
      }
      return;
    }

    if (state.turnUserId === me.userId) {
      el.className = "banner good";
      if (state.resolving) el.textContent = "카드 판정 중...";
      else el.textContent = "당신 차례입니다. 카드 2장을 선택하세요.";
    } else {
      const now = state.players.find((p) => p.userId === state.turnUserId);
      el.className = "banner";
      el.textContent = `지금 ${now ? now.username : "알 수 없음"}님 차례입니다.`;
    }
  }

  function renderBoard(state) {
    const board = $("memoryBoard");
    board.innerHTML = "";

    if (!state || !Array.isArray(state.cards) || state.cards.length === 0) {
      board.style.gridTemplateColumns = "repeat(5, minmax(0, 1fr))";
      for (let i = 0; i < 20; i++) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "memory-card";
        card.disabled = true;
        card.innerHTML = '<span class="memory-back">❓</span>';
        board.append(card);
      }
      return;
    }

    const cols = columnsForCount(state.cardCount || state.cards.length);
    board.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    const canPick = state.status === "playing" && state.turnUserId === me.userId && !state.resolving;

    for (const cardState of state.cards) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "memory-card";
      if (cardState.visible) btn.classList.add("open");
      if (cardState.matched) btn.classList.add("matched");

      if (cardState.visible) {
        const front = document.createElement("div");
        front.className = "memory-front";
        const flag = document.createElement("div");
        flag.className = "memory-flag";
        flag.textContent = cardState.flag || "🏳️";
        const name = document.createElement("div");
        name.className = "memory-country";
        name.textContent = cardState.nameKo || "";
        front.append(flag, name);
        btn.append(front);
      } else {
        const back = document.createElement("span");
        back.className = "memory-back";
        back.textContent = "❓";
        btn.append(back);
      }

      if (!canPick || cardState.visible || cardState.matched) {
        btn.disabled = true;
      }

      btn.addEventListener("click", async () => {
        if (!roomCode) return;
        const r = await apiJson(`/api/memory/rooms/${encodeURIComponent(roomCode)}/pick`, {
          method: "POST",
          body: { index: cardState.index },
        });
        if (!r.ok || !r.data?.ok) {
          const err = r.data?.error || "unknown";
          if (err === "not_your_turn") setMsg("아직 내 차례가 아닙니다.", "error");
          else if (err === "already_revealed") setMsg("이미 열린 카드입니다.", "error");
          else if (err === "already_matched") setMsg("이미 맞춘 카드입니다.", "error");
          else if (err === "resolving") setMsg("카드 판정 중입니다. 잠시만 기다려주세요.", "error");
          else setMsg("카드 선택 실패", "error");
        }
      });

      board.append(btn);
    }
  }

  function applyState(state) {
    roomState = state;
    roomCode = state.code;
    $("memoryCode").value = state.code;

    renderTurn(state);
    renderPlayers(state);
    renderBoard(state);

    const isHost = state.hostUserId === me.userId;
    $("startMemory").style.display = isHost ? "inline-flex" : "none";
    $("startMemory").disabled = state.status !== "lobby";
    $("cardCount").disabled = !isHost || state.status !== "lobby";
    if (state.status === "lobby") $("cardCount").value = String(state.cardCount || 40);
  }

  function resetUI() {
    roomCode = "";
    roomState = null;
    $("memoryCode").value = "";
    $("startMemory").style.display = "none";
    $("memoryPlayers").innerHTML = "";
    renderTurn(null);
    renderBoard(null);
  }

  async function joinRoom(code) {
    const r = await apiJson(`/api/memory/rooms/${encodeURIComponent(code)}/join`, { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "room_not_found") setMsg("방을 찾을 수 없습니다.", "error");
      else if (err === "room_full") setMsg("방 인원이 가득 찼습니다.", "error");
      else if (err === "room_not_joinable") setMsg("이미 시작된 방입니다.", "error");
      else setMsg("방 참가 실패", "error");
      return;
    }
    applyState(r.data.room);
    openStream(code);
    setMsg("메모리방 참가 완료", "ok");
  }

  $("createMemory").addEventListener("click", async () => {
    const cardCount = Number($("cardCount").value || 40);
    const r = await apiJson("/api/memory/rooms", { method: "POST", body: { cardCount } });
    if (!r.ok || !r.data?.ok) {
      setMsg("방 생성 실패", "error");
      return;
    }
    await joinRoom(r.data.code);
  });

  $("joinMemory").addEventListener("click", async () => {
    const code = String($("memoryCode").value || "").trim().toUpperCase();
    if (!code) {
      setMsg("방 코드를 입력하세요.", "error");
      return;
    }
    await joinRoom(code);
  });

  $("leaveMemory").addEventListener("click", async () => {
    if (!roomCode) {
      setMsg("참가 중인 방이 없습니다.", "muted");
      return;
    }
    await apiJson(`/api/memory/rooms/${encodeURIComponent(roomCode)}/leave`, { method: "POST" });
    closeStream();
    resetUI();
    setMsg("방에서 나왔습니다.", "ok");
  });

  $("startMemory").addEventListener("click", async () => {
    if (!roomCode) return;
    const cardCount = Number($("cardCount").value || 40);
    const r = await apiJson(`/api/memory/rooms/${encodeURIComponent(roomCode)}/start`, {
      method: "POST",
      body: { cardCount },
    });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "host_only") setMsg("방장만 시작할 수 있습니다.", "error");
      else if (err === "invalid_card_count") setMsg("카드 수는 20/30/40/50/60만 가능합니다.", "error");
      else setMsg("게임 시작 실패", "error");
    }
  });

  window.addEventListener("beforeunload", closeStream);

  resetUI();
  setMsg("메모리방을 만들거나 코드로 참가하세요.", "muted");
};
