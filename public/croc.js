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
  const el = $("crocMsg");
  el.textContent = text || "";
  el.className = `status-msg ${kind}`.trim();
}

window.initCrocPage = async function initCrocPage() {
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

  let roomState = null;
  let roomCode = "";
  let es = null;

  function closeStream() {
    if (es) {
      es.close();
      es = null;
    }
  }

  function openStream(code) {
    closeStream();
    es = new EventSource(`/sse/croc/${encodeURIComponent(code)}`);
    es.addEventListener("state", (ev) => {
      const data = JSON.parse(ev.data);
      applyState(data);
    });
    es.onerror = () => {
      setMsg("연결이 불안정합니다. 자동 재연결 중...", "muted");
    };
  }

  function renderPlayers(state) {
    const wrap = $("crocPlayers");
    wrap.innerHTML = "";
    const players = [...state.players];
    for (const p of players) {
      const row = document.createElement("div");
      row.className = "player";

      const left = document.createElement("div");
      left.className = "name";
      left.textContent = p.username + (p.userId === state.hostUserId ? " (방장)" : "");

      const right = document.createElement("div");
      right.className = "meta";
      const dot = document.createElement("span");
      dot.className = "dot" + (p.online ? " on" : "");
      const tag = document.createElement("span");
      if (state.turnUserId === p.userId && state.status === "playing") tag.textContent = "현재 차례";
      else if (state.status === "ended" && state.loserUserId === p.userId) tag.textContent = "패배";
      else if (state.status === "ended" && state.winnerUserId === p.userId) tag.textContent = "승리";
      else tag.textContent = p.online ? "online" : "offline";
      right.append(dot, tag);

      row.append(left, right);
      wrap.append(row);
    }
  }

  function renderTeeth(state) {
    const top = $("teethTop");
    const bottom = $("teethBottom");
    top.innerHTML = "";
    bottom.innerHTML = "";
    const selected = new Set(state.selectedTeeth || []);
    const myTurn = state.status === "playing" && state.turnUserId === me.userId;

    for (let tooth = 1; tooth <= 40; tooth++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "croc-tooth";
      btn.textContent = String(tooth);
      if (selected.has(tooth)) {
        btn.disabled = true;
        btn.classList.add("picked");
      }

      if (state.status === "ended" && state.lastPickedTooth === tooth) {
        btn.classList.add("trap");
      }

      if (state.status !== "playing" || !myTurn || selected.has(tooth)) btn.disabled = true;

      btn.addEventListener("click", async () => {
        if (!roomCode) return;
        const r = await apiJson(`/api/croc/rooms/${encodeURIComponent(roomCode)}/pick`, {
          method: "POST",
          body: { tooth },
        });
        if (!r.ok || !r.data?.ok) {
          const err = r.data?.error || "unknown";
          if (err === "not_your_turn") setMsg("아직 내 차례가 아닙니다.", "error");
          else if (err === "already_selected") setMsg("이미 눌린 이빨입니다.", "error");
          else if (err === "invalid_tooth") setMsg("유효하지 않은 이빨입니다.", "error");
          else setMsg("이빨 선택 실패", "error");
        }
      });

      if (tooth <= 20) top.append(btn);
      else bottom.append(btn);
    }
  }

  function renderTurn(state) {
    const el = $("crocTurn");
    if (!state) {
      el.textContent = "방을 만들거나 참가하세요.";
      el.className = "banner";
      return;
    }

    if (state.status === "lobby") {
      el.textContent = "대기중: 방장이 게임 시작을 누르면 시작됩니다.";
      el.className = "banner";
      return;
    }

    if (state.status === "ended") {
      if (state.loserUsername) {
        el.textContent = `${state.loserUsername}님이 함정 이빨을 눌러 패배했습니다.`;
      } else {
        el.textContent = "게임 종료";
      }
      el.className = "banner";
      return;
    }

    const now = state.players.find((p) => p.userId === state.turnUserId);
    if (state.turnUserId === me.userId) {
      el.textContent = "지금 당신 차례입니다. 이빨 1개를 선택하세요.";
      el.className = "banner good";
    } else {
      el.textContent = `지금 ${now ? now.username : "알 수 없음"}님 차례입니다.`;
      el.className = "banner";
    }
  }

  function applyState(state) {
    roomState = state;
    roomCode = state.code;
    $("crocCode").value = state.code;

    renderPlayers(state);
    renderTeeth(state);
    renderTurn(state);

    const isHost = state.hostUserId === me.userId;
    $("startCroc").style.display = isHost ? "inline-flex" : "none";
    $("startCroc").disabled = state.status !== "lobby";

    const mouthClosed = state.status === "ended" && state.loserUserId != null;
    $("crocMouth").classList.toggle("closed", mouthClosed);
  }

  async function joinRoom(code) {
    const r = await apiJson(`/api/croc/rooms/${encodeURIComponent(code)}/join`, { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "room_not_found") setMsg("방을 찾을 수 없습니다.", "error");
      else if (err === "room_not_joinable") setMsg("이미 시작된 방입니다.", "error");
      else setMsg("방 참가 실패", "error");
      return;
    }
    roomCode = code;
    applyState(r.data.room);
    openStream(code);
    setMsg("악어방 참가 완료", "ok");
  }

  $("createCroc").addEventListener("click", async () => {
    const r = await apiJson("/api/croc/rooms", { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      setMsg("방 생성 실패", "error");
      return;
    }
    await joinRoom(r.data.code);
  });

  $("joinCroc").addEventListener("click", async () => {
    const code = String($("crocCode").value || "").trim().toUpperCase();
    if (!code) {
      setMsg("방 코드를 입력하세요.", "error");
      return;
    }
    await joinRoom(code);
  });

  $("leaveCroc").addEventListener("click", async () => {
    if (!roomCode) {
      setMsg("참가 중인 방이 없습니다.", "muted");
      return;
    }
    await apiJson(`/api/croc/rooms/${encodeURIComponent(roomCode)}/leave`, { method: "POST" });
    closeStream();
    roomCode = "";
    roomState = null;
    $("crocCode").value = "";
    $("crocPlayers").innerHTML = "";
    $("teethTop").innerHTML = "";
    $("teethBottom").innerHTML = "";
    $("crocMouth").classList.remove("closed");
    renderTurn(null);
    setMsg("방에서 나왔습니다.", "ok");
  });

  $("startCroc").addEventListener("click", async () => {
    if (!roomCode) return;
    const r = await apiJson(`/api/croc/rooms/${encodeURIComponent(roomCode)}/start`, { method: "POST" });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "need_two_players") setMsg("최소 2명이 필요합니다.", "error");
      else if (err === "host_only") setMsg("방장만 시작할 수 있습니다.", "error");
      else setMsg("게임 시작 실패", "error");
    }
  });

  renderTurn(null);
  setMsg("악어방을 만들거나 코드로 참가하세요.", "muted");
};
