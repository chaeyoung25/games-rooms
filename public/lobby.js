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

  $("create").addEventListener("click", async () => {
    setMsg("", "");
    const size = Number($("size").value);
    const r = await apiJson("/api/rooms", { method: "POST", body: { size } });
    if (!r.ok || !r.data?.ok) {
      setMsg("방 만들기 실패. 다시 시도해주세요.", "error");
      return;
    }
    location.href = `/room/${r.data.code}`;
  });

  $("join").addEventListener("click", () => {
    setMsg("", "");
    const code = String($("code").value || "").trim().toUpperCase();
    if (!code) {
      setMsg("방 코드를 입력해주세요.", "error");
      return;
    }
    location.href = `/room/${encodeURIComponent(code)}`;
  });
};

