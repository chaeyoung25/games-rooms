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

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = kind ? kind : "";
}

window.initLoginPage = function initLoginPage() {
  const form = document.getElementById("login-form");
  const msg = document.getElementById("msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg(msg, "", "");
    const username = document.getElementById("username").value;
    const r = await apiJson("/api/login", { method: "POST", body: { username } });
    if (!r.ok || !r.data?.ok) {
      const err = r.data?.error || "unknown";
      if (err === "username_length") setMsg(msg, "아이디는 2~20자로 입력해주세요.", "error");
      else setMsg(msg, "로그인 실패. 다시 시도해주세요.", "error");
      return;
    }
    location.href = "/lobby";
  });
};

window.initSignupPage = function initSignupPage() {
  location.href = "/login";
};
