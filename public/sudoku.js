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

const SUDOKU_9_SET = [
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

function makeRange(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function gridToFlat(grid) {
  return grid.flat();
}

function makeLatinSolution(size) {
  const symbols = shuffled(Array.from({ length: size }, (_, i) => i + 1));
  const rowShift = shuffled(makeRange(size));
  const colShift = shuffled(makeRange(size));
  const grid = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const v = symbols[(rowShift[r] + colShift[c]) % size];
      row.push(v);
    }
    grid.push(row);
  }
  return grid;
}

function blankRatioBySize(size) {
  if (size <= 5) return 0.36;
  if (size === 6) return 0.42;
  if (size === 7) return 0.46;
  if (size === 8) return 0.5;
  return 0.58;
}

function makePuzzleFromSolution(solutionGrid) {
  const size = solutionGrid.length;
  const flat = gridToFlat(solutionGrid);
  const puzzle = flat.map((v) => String(v));
  const total = size * size;
  const targetBlanks = Math.floor(total * blankRatioBySize(size));

  const rowGiven = Array.from({ length: size }, () => size);
  const colGiven = Array.from({ length: size }, () => size);
  const order = shuffled(makeRange(total));

  let blanks = 0;
  for (const idx of order) {
    if (blanks >= targetBlanks) break;
    const r = Math.floor(idx / size);
    const c = idx % size;
    if (rowGiven[r] <= 2 || colGiven[c] <= 2) continue;
    puzzle[idx] = "0";
    rowGiven[r]--;
    colGiven[c]--;
    blanks++;
  }

  return puzzle.join("");
}

function buildPuzzle(size) {
  if (size === 9) {
    const one = pickOne(SUDOKU_9_SET);
    return {
      size,
      puzzle: one.puzzle,
      solution: one.solution,
      useClassicBlocks: true,
    };
  }

  const solutionGrid = makeLatinSolution(size);
  const puzzle = makePuzzleFromSolution(solutionGrid);
  const solution = gridToFlat(solutionGrid).join("");
  return {
    size,
    puzzle,
    solution,
    useClassicBlocks: false,
  };
}

function getCellIndex(size, r, c) {
  return r * size + c;
}

function readValues(boardEl) {
  return Array.from(boardEl.querySelectorAll("input.sudoku-cell")).map((cell) => String(cell.value || "").trim());
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
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
  const sizeEl = document.getElementById("sudokuSize");
  const elapsedEl = document.getElementById("sudokuElapsed");
  const bestEl = document.getElementById("sudokuBest");

  let current = buildPuzzle(9);
  let gameOver = false;
  let startedAt = 0;
  let timer = null;

  function bestKey() {
    return `sudoku_best_${current.size}`;
  }

  function readBest() {
    const raw = localStorage.getItem(bestKey());
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return null;
    return v;
  }

  function renderBest() {
    const best = readBest();
    bestEl.textContent = best == null ? "-" : formatElapsed(best);
  }

  function setMainMsg(text, kind = "muted") {
    msgEl.textContent = text;
    msgEl.className = `status-msg ${kind}`.trim();
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startTimer() {
    stopTimer();
    startedAt = Date.now();
    elapsedEl.textContent = "00:00";
    timer = setInterval(() => {
      elapsedEl.textContent = formatElapsed(Date.now() - startedAt);
    }, 250);
  }

  function finishGameFromSolved() {
    if (gameOver) return;
    gameOver = true;
    stopTimer();
    const elapsedMs = Date.now() - startedAt;
    const prev = readBest();
    if (prev == null || elapsedMs < prev) {
      localStorage.setItem(bestKey(), String(elapsedMs));
      setMainMsg(`정답입니다! 기록 ${formatElapsed(elapsedMs)} (최고 기록 갱신)`, "ok");
    } else {
      setMainMsg(`정답입니다! 기록 ${formatElapsed(elapsedMs)}`, "ok");
    }
    renderBest();
  }

  function render() {
    const size = current.size;
    boardEl.innerHTML = "";
    boardEl.style.setProperty("--sudoku-size", String(size));
    boardEl.style.gridTemplateColumns = `repeat(${size}, minmax(0, 1fr))`;

    const puzzle = current.puzzle;
    const block = current.useClassicBlocks ? 3 : 0;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const idx = getCellIndex(size, r, c);
        const given = puzzle[idx] !== "0";
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.autocomplete = "off";
        input.maxLength = 1;
        input.className = "sudoku-cell";
        if (given) input.classList.add("given");
        if (block > 0 && c % block === block - 1 && c !== size - 1) input.classList.add("thick-r");
        if (block > 0 && r % block === block - 1 && r !== size - 1) input.classList.add("thick-b");
        input.value = given ? puzzle[idx] : "";
        input.disabled = given;

        input.addEventListener("input", () => {
          const raw = input.value.replace(/\D/g, "");
          if (!raw) {
            input.value = "";
            return;
          }
          const n = Number(raw[0]);
          input.value = n >= 1 && n <= size ? String(n) : "";
        });

        boardEl.append(input);
      }
    }

    gameOver = false;
    setMainMsg("혼자 풀기 모드: 완성 시간 기록에 도전하세요.", "muted");
    renderBest();
    startTimer();
  }

  function newPuzzle() {
    const size = Number(sizeEl.value || 9);
    current = buildPuzzle(size);
    render();
  }

  document.getElementById("newSudoku").addEventListener("click", newPuzzle);

  sizeEl.addEventListener("change", () => {
    newPuzzle();
  });

  document.getElementById("checkSudoku").addEventListener("click", () => {
    const values = readValues(boardEl);
    if (values.some((v) => !v)) {
      setMainMsg("모든 칸을 채워주세요.", "error");
      return;
    }

    if (values.join("") === current.solution) {
      finishGameFromSolved();
      return;
    }

    setMainMsg("아직 정답이 아니에요. 다시 확인해보세요.", "error");
  });

  newPuzzle();
};
