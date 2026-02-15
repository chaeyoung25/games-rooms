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

window.initCrocPage = async function initCrocPage() {
  const meRes = await apiJson("/api/me");
  if (!meRes.data?.user) {
    location.href = "/login";
    return;
  }
  document.getElementById("me").textContent = meRes.data.user.username;

  document.getElementById("logout").addEventListener("click", async () => {
    await apiJson("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  const msgEl = document.getElementById("crocMsg");
  const wrap = document.getElementById("crocTeeth");
  let trap = 0;
  let finished = false;

  function reset() {
    trap = Math.floor(Math.random() * 12);
    finished = false;
    msgEl.textContent = "아래 이빨을 눌러보세요.";
    msgEl.className = "status-msg muted";
    wrap.innerHTML = "";

    for (let i = 0; i < 12; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tooth-btn";
      btn.textContent = String(i + 1);
      btn.addEventListener("click", () => {
        if (finished || btn.disabled) return;
        if (i === trap) {
          finished = true;
          btn.classList.add("trap");
          msgEl.textContent = "악어가 물었어요! 게임 오버";
          msgEl.className = "status-msg error";
          for (const b of wrap.querySelectorAll("button")) b.disabled = true;
          return;
        }
        btn.disabled = true;
        btn.classList.add("safe");
        const left = Array.from(wrap.querySelectorAll("button")).filter((b) => !b.disabled).length;
        if (left === 1) {
          finished = true;
          msgEl.textContent = "승리! 함정 이빨을 피했습니다.";
          msgEl.className = "status-msg ok";
          for (const b of wrap.querySelectorAll("button")) b.disabled = true;
        } else {
          msgEl.textContent = "세이프! 계속 눌러보세요.";
          msgEl.className = "status-msg ok";
        }
      });
      wrap.append(btn);
    }
  }

  document.getElementById("resetCroc").addEventListener("click", reset);
  reset();
};
