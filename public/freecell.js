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

const SUITS = ["S", "H", "D", "C"];
const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  1: "A",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
};

function cardColor(suit) {
  return suit === "H" || suit === "D" ? "red" : "black";
}

function makeDeck() {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: id++, suit, rank, color: cardColor(suit) });
    }
  }
  return deck;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

window.initFreecellPage = async function initFreecellPage() {
  const meRes = await apiJson("/api/me");
  if (!meRes.data?.user) {
    location.href = "/login";
    return;
  }
  $("me").textContent = meRes.data.user.username;

  $("logout").addEventListener("click", async () => {
    await apiJson("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  const state = {
    free: [null, null, null, null],
    foundations: { S: 0, H: 0, D: 0, C: 0 },
    cascades: Array.from({ length: 8 }, () => []),
    selected: null,
    moves: 0,
    won: false,
  };

  function setMsg(text, kind = "") {
    const el = $("freecellMsg");
    el.textContent = text || "";
    el.className = `status-msg ${kind}`.trim();
  }

  function progressCount() {
    return SUITS.reduce((acc, s) => acc + Number(state.foundations[s] || 0), 0);
  }

  function updateStatus() {
    $("freecellMoves").textContent = String(state.moves);
    $("freecellProgress").textContent = `${progressCount()}/52`;
  }

  function isSelected(fromType, fromIndex) {
    return state.selected && state.selected.fromType === fromType && state.selected.fromIndex === fromIndex;
  }

  function getSourceCard(fromType, fromIndex) {
    if (fromType === "free") return state.free[fromIndex];
    const pile = state.cascades[fromIndex];
    if (!pile || pile.length === 0) return null;
    return pile[pile.length - 1];
  }

  function popSourceCard(fromType, fromIndex) {
    if (fromType === "free") {
      const card = state.free[fromIndex];
      state.free[fromIndex] = null;
      return card;
    }
    return state.cascades[fromIndex].pop();
  }

  function clearSelection() {
    state.selected = null;
  }

  function canMoveToFree(card, idx) {
    if (!card) return false;
    return state.free[idx] == null;
  }

  function canMoveToFoundation(card, suit) {
    if (!card || card.suit !== suit) return false;
    return card.rank === state.foundations[suit] + 1;
  }

  function canMoveToCascade(card, idx) {
    if (!card) return false;
    const pile = state.cascades[idx];
    if (!pile || pile.length === 0) return true;
    const top = pile[pile.length - 1];
    return top.color !== card.color && top.rank === card.rank + 1;
  }

  function tryMoveSelectedTo(targetType, targetIndex) {
    if (!state.selected) return false;

    const { fromType, fromIndex } = state.selected;
    const card = getSourceCard(fromType, fromIndex);
    if (!card) {
      clearSelection();
      renderAll();
      return false;
    }

    if (fromType === targetType && fromIndex === targetIndex) {
      clearSelection();
      renderAll();
      return false;
    }

    let legal = false;
    if (targetType === "free") legal = canMoveToFree(card, targetIndex);
    else if (targetType === "foundation") legal = canMoveToFoundation(card, targetIndex);
    else if (targetType === "cascade") legal = canMoveToCascade(card, targetIndex);

    if (!legal) {
      setMsg("그 위치로는 이동할 수 없습니다.", "error");
      return false;
    }

    const moved = popSourceCard(fromType, fromIndex);
    if (!moved) return false;

    if (targetType === "free") {
      state.free[targetIndex] = moved;
    } else if (targetType === "foundation") {
      state.foundations[targetIndex] = moved.rank;
    } else {
      state.cascades[targetIndex].push(moved);
    }

    state.moves += 1;
    clearSelection();
    setMsg("", "");
    if (progressCount() === 52) {
      state.won = true;
      setMsg(`클리어! 총 이동수 ${state.moves}`, "ok");
    }
    renderAll();
    return true;
  }

  function tryAutoToFoundationFrom(fromType, fromIndex) {
    const card = getSourceCard(fromType, fromIndex);
    if (!card) return false;
    if (!canMoveToFoundation(card, card.suit)) return false;
    state.selected = { fromType, fromIndex };
    return tryMoveSelectedTo("foundation", card.suit);
  }

  function autoFoundation() {
    let movedAny = false;
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < 4; i++) {
        if (tryAutoToFoundationFrom("free", i)) {
          moved = true;
          movedAny = true;
        }
      }
      for (let i = 0; i < 8; i++) {
        if (tryAutoToFoundationFrom("cascade", i)) {
          moved = true;
          movedAny = true;
        }
      }
    }
    if (!movedAny) setMsg("자동으로 올릴 수 있는 카드가 없습니다.", "muted");
  }

  function cardNode(card, fromType, fromIndex) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `fc-card ${card.color}`;
    if (isSelected(fromType, fromIndex)) btn.classList.add("selected");

    const rank = document.createElement("span");
    rank.className = "fc-rank";
    rank.textContent = RANK_LABEL[card.rank];

    const suit = document.createElement("span");
    suit.className = "fc-suit";
    suit.textContent = SUIT_SYMBOL[card.suit];

    btn.append(rank, suit);

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.selected) {
        if (!tryMoveSelectedTo(fromType, fromIndex)) {
          const topCard = getSourceCard(fromType, fromIndex);
          if (!topCard || topCard.id !== card.id) return;
          state.selected = { fromType, fromIndex };
          renderAll();
        }
        return;
      }
      const topCard = getSourceCard(fromType, fromIndex);
      if (!topCard || topCard.id !== card.id) return;
      state.selected = { fromType, fromIndex };
      setMsg("이동할 위치(빈 칸/기둥/완성칸)를 선택하세요.", "muted");
      renderAll();
    });

    btn.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      state.selected = { fromType, fromIndex };
      if (!tryMoveSelectedTo("foundation", card.suit)) {
        clearSelection();
        renderAll();
      }
    });

    return btn;
  }

  function renderTop() {
    const top = $("freecellTop");
    top.innerHTML = "";

    const freeWrap = document.createElement("div");
    freeWrap.className = "fc-group";
    for (let i = 0; i < 4; i++) {
      const slot = document.createElement("div");
      slot.className = "fc-slot";
      if (isSelected("free", i)) slot.classList.add("selected");
      const card = state.free[i];
      if (card) slot.append(cardNode(card, "free", i));
      else {
        slot.innerHTML = '<span class="fc-slot-label">FREE</span>';
      }
      slot.addEventListener("click", () => {
        if (state.selected) {
          tryMoveSelectedTo("free", i);
          return;
        }
        if (card) {
          state.selected = { fromType: "free", fromIndex: i };
          renderAll();
        }
      });
      freeWrap.append(slot);
    }

    const foundWrap = document.createElement("div");
    foundWrap.className = "fc-group";
    for (const suit of SUITS) {
      const slot = document.createElement("div");
      slot.className = "fc-slot foundation";
      const rank = state.foundations[suit];
      if (rank > 0) {
        const card = document.createElement("div");
        card.className = `fc-card static ${cardColor(suit)}`;
        const rankEl = document.createElement("span");
        rankEl.className = "fc-rank";
        rankEl.textContent = RANK_LABEL[rank];
        const suitEl = document.createElement("span");
        suitEl.className = "fc-suit";
        suitEl.textContent = SUIT_SYMBOL[suit];
        card.append(rankEl, suitEl);
        slot.append(card);
      } else {
        const lab = document.createElement("span");
        lab.className = `fc-slot-label ${cardColor(suit)}`;
        lab.textContent = SUIT_SYMBOL[suit];
        slot.append(lab);
      }
      slot.addEventListener("click", () => {
        if (state.selected) tryMoveSelectedTo("foundation", suit);
      });
      foundWrap.append(slot);
    }

    top.append(freeWrap, foundWrap);
  }

  function renderCascades() {
    const root = $("freecellCascades");
    root.innerHTML = "";

    for (let i = 0; i < 8; i++) {
      const pile = state.cascades[i];
      const col = document.createElement("div");
      col.className = "fc-column";

      if (!pile || pile.length === 0) {
        const empty = document.createElement("span");
        empty.className = "fc-empty";
        empty.textContent = "EMPTY";
        col.append(empty);
      } else {
        for (let p = 0; p < pile.length; p++) {
          const holder = document.createElement("div");
          holder.className = "fc-card-holder";
          holder.style.top = `${p * 26}px`;
          const card = pile[p];
          holder.append(cardNode(card, "cascade", i));
          col.append(holder);
        }
      }

      col.addEventListener("click", () => {
        if (state.selected) {
          tryMoveSelectedTo("cascade", i);
          return;
        }
        if (pile && pile.length > 0) {
          state.selected = { fromType: "cascade", fromIndex: i };
          renderAll();
        }
      });

      root.append(col);
    }
  }

  function renderAll() {
    renderTop();
    renderCascades();
    updateStatus();
  }

  function newGame() {
    const deck = shuffle(makeDeck());
    state.free = [null, null, null, null];
    state.foundations = { S: 0, H: 0, D: 0, C: 0 };
    state.cascades = Array.from({ length: 8 }, () => []);
    state.selected = null;
    state.moves = 0;
    state.won = false;

    for (let i = 0; i < deck.length; i++) {
      state.cascades[i % 8].push(deck[i]);
    }

    setMsg("프리셀 시작! 카드 클릭 후 이동 위치를 선택하세요.", "muted");
    renderAll();
  }

  $("newFreecell").addEventListener("click", newGame);
  $("autoFoundation").addEventListener("click", autoFoundation);

  newGame();
};
