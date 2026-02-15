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

const SUDOKU_SET = [
  {
    puzzle:
      "530070000600195000098000060800060003400803001700020006060000280000419005000080079",
    solution:
      "534678912672195348198342567859761423426853791713924856961537284287419635345286179",
  },
  {
    puzzle:
      "009000000080605020501078000000000700706040102004000000000720903090301080000000600",
    solution:
      "279134865384695721561278349913852746756943182824716593148527963697381254235469617",
  },
  {
    puzzle:
      "000260701680070090190004500820100040004602900050003028009300074040050036703018000",
    solution:
      "435269781682571493197834562826195347374682915951743628519326874248957136763418259",
  },
];

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getCellIndex(r, c) {
  return r * 9 + c;
}

function readBoard() {
  const out = [];
  const cells = document.querySelectorAll("#sudokuBoard input");
  for (const cell of cells) out.push(cell.value.trim());
  return out;
}

window.initSudokuPage = async function initSudokuPage() {
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

  const boardEl = document.getElementById("sudokuBoard");
  const msgEl = document.getElementById("sudokuMsg");
  let current = pickOne(SUDOKU_SET);

  function render() {
    boardEl.innerHTML = "";
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const idx = getCellIndex(r, c);
        const given = current.puzzle[idx] !== "0";
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.maxLength = 1;
        input.className = "sudoku-cell";
        if (given) input.classList.add("given");
        if (c % 3 === 2 && c !== 8) input.classList.add("thick-r");
        if (r % 3 === 2 && r !== 8) input.classList.add("thick-b");
        input.value = given ? current.puzzle[idx] : "";
        input.disabled = given;
        input.addEventListener("input", () => {
          const v = input.value.replace(/[^1-9]/g, "");
          input.value = v.slice(0, 1);
        });
        boardEl.append(input);
      }
    }
    msgEl.textContent = "빈 칸을 채운 뒤 정답 확인을 눌러보세요.";
    msgEl.className = "status-msg muted";
  }

  document.getElementById("newSudoku").addEventListener("click", () => {
    current = pickOne(SUDOKU_SET);
    render();
  });

  document.getElementById("checkSudoku").addEventListener("click", () => {
    const values = readBoard().join("");
    if (values.includes("")) {
      msgEl.textContent = "모든 칸을 채워주세요.";
      msgEl.className = "status-msg error";
      return;
    }
    if (values.length !== 81) {
      msgEl.textContent = "입력이 올바르지 않습니다.";
      msgEl.className = "status-msg error";
      return;
    }
    if (values === current.solution) {
      msgEl.textContent = "정답입니다! 축하합니다.";
      msgEl.className = "status-msg ok";
    } else {
      msgEl.textContent = "아직 정답이 아니에요. 다시 확인해보세요.";
      msgEl.className = "status-msg error";
    }
  });

  render();
};
