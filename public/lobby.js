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
  const el = $("msg");
  el.textContent = text;
  el.className = kind;
}

window.initLobbyPage = async function initLobbyPage() {
  const me = await apiJson("/api/me");
  if (!me.data?.user) {
    location.href = "/login";
    return;
  }
  $("me").textContent = me.data.user.username;

  $("logout").addEventListener("click", async () => {
    await apiJson("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  const cards = Array.from(document.querySelectorAll(".game-card"));
  for (const card of cards) {
    card.addEventListener("click", () => {
      cards.forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      const game = card.dataset.game;
      if (game === "bingo") {
        setMsg("Bingo Room으로 이동합니다.", "ok");
        setTimeout(() => (location.href = "/bingo"), 120);
      } else if (game === "sudoku") {
        setMsg("Sudoku로 이동합니다.", "ok");
        setTimeout(() => (location.href = "/sudoku"), 120);
      } else if (game === "croc") {
        setMsg("악어이빨 누르기로 이동합니다.", "ok");
        setTimeout(() => (location.href = "/croc"), 120);
      } else {
        setMsg("이 게임은 준비중입니다. 카드 추가 후 라우트만 연결하면 바로 확장됩니다.", "muted");
      }
    });
  }
};
