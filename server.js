const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const VIEWS_DIR = path.join(ROOT_DIR, "views");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
const USERS_FILE = path.join(DATA_DIR, "users.json");

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function sendFile(res, filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeForPath(filePath),
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: "not_found" });
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  const input = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

function hmacBase64Url(input) {
  return base64UrlEncode(crypto.createHmac("sha256", SESSION_SECRET).update(input).digest());
}

function makeSessionCookieValue(sid) {
  return `${sid}.${hmacBase64Url(sid)}`;
}

function verifySessionCookieValue(value) {
  if (!value) return null;
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const sid = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = hmacBase64Url(sid);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return sid;
  } catch {
    return null;
  }
}

const sessions = new Map(); // sid -> { userId, username, createdAt, lastSeenAt }
const SESSION_COOKIE = "sid";

function getSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  const sid = verifySessionCookieValue(raw);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  s.lastSeenAt = Date.now();
  return s;
}

function setSession(res, sessionData) {
  const sid = base64UrlEncode(crypto.randomBytes(18));
  sessions.set(sid, {
    ...sessionData,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });

  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(makeSessionCookieValue(sid))}; HttpOnly; Path=/; SameSite=Lax${
    COOKIE_SECURE ? "; Secure" : ""
  }`;
  res.setHeader("Set-Cookie", cookie);
}

function clearSession(req, res) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  const sid = verifySessionCookieValue(raw);
  if (sid) sessions.delete(sid);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`
  );
}

async function readJsonBody(req, { maxBytes = 1024 * 32 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        resolve({ ok: false, error: "body_too_large", value: null });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = safeJsonParse(raw || "{}");
      if (!parsed.ok) resolve({ ok: false, error: "invalid_json", value: null });
      else resolve({ ok: true, error: null, value: parsed.value });
    });
  });
}

async function ensureData() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(USERS_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(USERS_FILE, JSON.stringify({ nextId: 1, users: [] }, null, 2), "utf8");
  }
}

let userDb = { nextId: 1, users: [] };
let userDbWriteInFlight = Promise.resolve();

async function loadUsers() {
  await ensureData();
  const raw = await fsp.readFile(USERS_FILE, "utf8");
  const parsed = safeJsonParse(raw);
  if (parsed.ok && parsed.value && typeof parsed.value === "object") {
    userDb = {
      nextId: Number(parsed.value.nextId || 1),
      users: Array.isArray(parsed.value.users) ? parsed.value.users : [],
    };
  }
}

function queueUserDbWrite() {
  userDbWriteInFlight = userDbWriteInFlight.then(async () => {
    const tmp = `${USERS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(userDb, null, 2), "utf8");
    await fsp.rename(tmp, USERS_FILE);
  });
  return userDbWriteInFlight;
}

function normalizeUsername(name) {
  return String(name || "").trim();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${base64UrlEncode(salt)}$${base64UrlEncode(key)}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3) return false;
  if (parts[0] !== "scrypt") return false;
  const salt = base64UrlDecode(parts[1]);
  const expected = base64UrlDecode(parts[2]);
  const actual = crypto.scryptSync(String(password || ""), salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function pickRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  return code;
}

function makeShuffledNumbers(n) {
  const arr = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateBoard(size) {
  const nums = makeShuffledNumbers(size * size);
  const board = [];
  for (let r = 0; r < size; r++) board.push(nums.slice(r * size, (r + 1) * size));
  return board;
}

function cryptoShuffleItems(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function countCompleteLines(board, calledSet) {
  const size = board.length;
  let lines = 0;

  // rows
  for (let r = 0; r < size; r++) {
    let ok = true;
    for (let c = 0; c < size; c++) {
      if (!calledSet.has(board[r][c])) {
        ok = false;
        break;
      }
    }
    if (ok) lines++;
  }

  // cols
  for (let c = 0; c < size; c++) {
    let ok = true;
    for (let r = 0; r < size; r++) {
      if (!calledSet.has(board[r][c])) {
        ok = false;
        break;
      }
    }
    if (ok) lines++;
  }

  // diagonals
  {
    let ok = true;
    for (let i = 0; i < size; i++) {
      if (!calledSet.has(board[i][i])) {
        ok = false;
        break;
      }
    }
    if (ok) lines++;
  }
  {
    let ok = true;
    for (let i = 0; i < size; i++) {
      if (!calledSet.has(board[i][size - 1 - i])) {
        ok = false;
        break;
      }
    }
    if (ok) lines++;
  }

  return lines;
}

const rooms = new Map(); // code -> room
const crocRooms = new Map(); // code -> crocRoom
const memoryRooms = new Map(); // code -> memoryRoom
const gomokuRooms = new Map(); // code -> gomokuRoom
const BINGO_BOT_USER_ID = "__bingo_bot__";
const BINGO_BOT_USERNAME = "COM";
const GOMOKU_SIZE = 15;

const MEMORY_CARD_COUNTS = new Set([20, 30, 40, 50, 60]);

const MEMORY_COUNTRIES = [
  { key: "kr", flag: "🇰🇷", nameKo: "대한민국" },
  { key: "us", flag: "🇺🇸", nameKo: "미국" },
  { key: "jp", flag: "🇯🇵", nameKo: "일본" },
  { key: "cn", flag: "🇨🇳", nameKo: "중국" },
  { key: "gb", flag: "🇬🇧", nameKo: "영국" },
  { key: "fr", flag: "🇫🇷", nameKo: "프랑스" },
  { key: "de", flag: "🇩🇪", nameKo: "독일" },
  { key: "it", flag: "🇮🇹", nameKo: "이탈리아" },
  { key: "es", flag: "🇪🇸", nameKo: "스페인" },
  { key: "pt", flag: "🇵🇹", nameKo: "포르투갈" },
  { key: "nl", flag: "🇳🇱", nameKo: "네덜란드" },
  { key: "be", flag: "🇧🇪", nameKo: "벨기에" },
  { key: "se", flag: "🇸🇪", nameKo: "스웨덴" },
  { key: "no", flag: "🇳🇴", nameKo: "노르웨이" },
  { key: "fi", flag: "🇫🇮", nameKo: "핀란드" },
  { key: "dk", flag: "🇩🇰", nameKo: "덴마크" },
  { key: "ch", flag: "🇨🇭", nameKo: "스위스" },
  { key: "at", flag: "🇦🇹", nameKo: "오스트리아" },
  { key: "pl", flag: "🇵🇱", nameKo: "폴란드" },
  { key: "gr", flag: "🇬🇷", nameKo: "그리스" },
  { key: "tr", flag: "🇹🇷", nameKo: "튀르키예" },
  { key: "ru", flag: "🇷🇺", nameKo: "러시아" },
  { key: "ca", flag: "🇨🇦", nameKo: "캐나다" },
  { key: "mx", flag: "🇲🇽", nameKo: "멕시코" },
  { key: "br", flag: "🇧🇷", nameKo: "브라질" },
  { key: "ar", flag: "🇦🇷", nameKo: "아르헨티나" },
  { key: "cl", flag: "🇨🇱", nameKo: "칠레" },
  { key: "au", flag: "🇦🇺", nameKo: "호주" },
  { key: "nz", flag: "🇳🇿", nameKo: "뉴질랜드" },
  { key: "in", flag: "🇮🇳", nameKo: "인도" },
  { key: "th", flag: "🇹🇭", nameKo: "태국" },
  { key: "vn", flag: "🇻🇳", nameKo: "베트남" },
  { key: "id", flag: "🇮🇩", nameKo: "인도네시아" },
  { key: "ph", flag: "🇵🇭", nameKo: "필리핀" },
  { key: "sg", flag: "🇸🇬", nameKo: "싱가포르" },
  { key: "my", flag: "🇲🇾", nameKo: "말레이시아" },
  { key: "sa", flag: "🇸🇦", nameKo: "사우디아라비아" },
  { key: "ae", flag: "🇦🇪", nameKo: "아랍에미리트" },
  { key: "eg", flag: "🇪🇬", nameKo: "이집트" },
  { key: "za", flag: "🇿🇦", nameKo: "남아프리카공화국" },
];

function roomPublicState(room) {
  return {
    code: room.code,
    size: room.size,
    targetLines: room.targetLines,
    botEnabled: Boolean(room.botEnabled),
    status: room.status,
    hostUserId: room.hostUserId,
    createdAt: room.createdAt,
    players: Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      online: Boolean(p.online),
      joinedAt: p.joinedAt,
      isBot: Boolean(p.isBot),
    })),
    calledNumbers: Array.from(room.calledNumbers),
    lastNumber: room.lastNumber ?? null,
    winners: room.winners,
    drawTimeoutSeconds: room.drawTimeoutSeconds,
    turnUserId: room.turnUserId ?? null,
    turnEndsAt: room.turnEndsAt ?? null,
    lastDrawByUserId: room.lastDrawByUserId ?? null,
    lastDrawByUsername: room.lastDrawByUsername ?? null,
    lastDrawReason: room.lastDrawReason ?? null,
  };
}

function crocRoomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostUserId: room.hostUserId,
    createdAt: room.createdAt,
    players: Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      online: Boolean(p.online),
      joinedAt: p.joinedAt,
      alive: Boolean(p.alive),
    })),
    selectedTeeth: Array.from(room.selectedTeeth).sort((a, b) => a - b),
    toothCountPerJaw: room.toothCountPerJaw,
    turnUserId: room.turnUserId ?? null,
    lastPickedTooth: room.lastPickedTooth ?? null,
    lastPickerUserId: room.lastPickerUserId ?? null,
    loserUserId: room.loserUserId ?? null,
    loserUsername: room.loserUsername ?? null,
    winnerUserId: room.winnerUserId ?? null,
    winnerUsername: room.winnerUsername ?? null,
  };
}

function memoryRoomPublicState(room) {
  const revealedSet = new Set(room.revealedIndices || []);
  return {
    code: room.code,
    status: room.status,
    hostUserId: room.hostUserId,
    createdAt: room.createdAt,
    cardCount: room.cardCount,
    pairsTotal: room.cardCount / 2,
    pairsMatched: room.matchedCount,
    players: Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      online: Boolean(p.online),
      joinedAt: p.joinedAt,
      score: Number(p.score || 0),
    })),
    turnUserId: room.turnUserId ?? null,
    resolving: Boolean(room.resolving),
    revealedIndices: [...room.revealedIndices],
    winners: room.winners || [],
    cards: room.cards.map((card, index) => {
      const visible = card.matched || revealedSet.has(index);
      return {
        index,
        matched: Boolean(card.matched),
        visible,
        flag: visible ? card.flag : null,
        nameKo: visible ? card.nameKo : null,
      };
    }),
  };
}

function gomokuRoomPublicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostUserId: room.hostUserId,
    createdAt: room.createdAt,
    boardSize: room.boardSize,
    board: room.board,
    turnUserId: room.turnUserId ?? null,
    winnerUserId: room.winnerUserId ?? null,
    winnerUsername: room.winnerUsername ?? null,
    winnerStone: room.winnerStone ?? null,
    draw: Boolean(room.draw),
    lastMoveIndex: room.lastMoveIndex ?? null,
    lastMoveByUserId: room.lastMoveByUserId ?? null,
    players: Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      online: Boolean(p.online),
      joinedAt: p.joinedAt,
      stone: p.stone || null,
    })),
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastRoom(room, event, data) {
  for (const sub of room.subscribers) {
    try {
      sseWrite(sub.res, event, data);
    } catch {
      // ignore broken pipes
    }
  }
}

function broadcastCrocRoom(room, event, data) {
  for (const sub of room.subscribers) {
    try {
      sseWrite(sub.res, event, data);
    } catch {
      // ignore broken pipes
    }
  }
}

function broadcastMemoryRoom(room, event, data) {
  for (const sub of room.subscribers) {
    try {
      sseWrite(sub.res, event, data);
    } catch {
      // ignore broken pipes
    }
  }
}

function broadcastGomokuRoom(room, event, data) {
  for (const sub of room.subscribers) {
    try {
      sseWrite(sub.res, event, data);
    } catch {
      // ignore broken pipes
    }
  }
}

function pruneRoomIfEmpty(room) {
  const hasHuman = Array.from(room.players.keys()).some((id) => id !== BINGO_BOT_USER_ID);
  if (hasHuman) return;
  clearTurnTimer(room);
  try {
    for (const sub of room.subscribers) sub.res.end();
  } catch {
    // ignore
  }
  rooms.delete(room.code);
}

function pruneCrocRoomIfEmpty(room) {
  if (room.players.size > 0) return;
  try {
    for (const sub of room.subscribers) sub.res.end();
  } catch {
    // ignore
  }
  crocRooms.delete(room.code);
}

function pruneMemoryRoomIfEmpty(room) {
  if (room.players.size > 0) return;
  if (room.resolveTimer) {
    clearTimeout(room.resolveTimer);
    room.resolveTimer = null;
  }
  try {
    for (const sub of room.subscribers) sub.res.end();
  } catch {
    // ignore
  }
  memoryRooms.delete(room.code);
}

function pruneGomokuRoomIfEmpty(room) {
  if (room.players.size > 0) return;
  try {
    for (const sub of room.subscribers) sub.res.end();
  } catch {
    // ignore
  }
  gomokuRooms.delete(room.code);
}

function crocSetTurnByCursor(room) {
  if (room.turnOrder.length === 0) {
    room.turnUserId = null;
    return;
  }
  room.turnCursor = ((room.turnCursor % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
  room.turnUserId = room.turnOrder[room.turnCursor];
}

function memorySetTurnByCursor(room) {
  if (room.turnOrder.length === 0) {
    room.turnUserId = null;
    return;
  }
  room.turnCursor = ((room.turnCursor % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
  room.turnUserId = room.turnOrder[room.turnCursor];
}

function gomokuSetTurnByCursor(room) {
  if (room.turnOrder.length === 0) {
    room.turnUserId = null;
    return;
  }
  room.turnCursor = ((room.turnCursor % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
  room.turnUserId = room.turnOrder[room.turnCursor];
}

function gomokuHasFive(board, boardSize, index, stone) {
  const row = Math.floor(index / boardSize);
  const col = index % boardSize;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of directions) {
    let count = 1;
    for (let dir = -1; dir <= 1; dir += 2) {
      let r = row + dr * dir;
      let c = col + dc * dir;
      while (r >= 0 && r < boardSize && c >= 0 && c < boardSize) {
        const i = r * boardSize + c;
        if (board[i] !== stone) break;
        count += 1;
        r += dr * dir;
        c += dc * dir;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

function buildMemoryDeck(cardCount) {
  const pairCount = Math.floor(cardCount / 2);
  const picked = cryptoShuffleItems(MEMORY_COUNTRIES).slice(0, pairCount);
  const cards = [];
  let uid = 0;
  for (const c of picked) {
    cards.push({
      uid: uid++,
      countryKey: c.key,
      flag: c.flag,
      nameKo: c.nameKo,
      matched: false,
    });
    cards.push({
      uid: uid++,
      countryKey: c.key,
      flag: c.flag,
      nameKo: c.nameKo,
      matched: false,
    });
  }
  return cryptoShuffleItems(cards);
}

function memoryFinalizeIfDone(room) {
  if (room.matchedCount < room.cardCount / 2) return false;
  room.status = "ended";
  room.turnUserId = null;
  room.revealedIndices = [];
  room.resolving = false;
  if (room.resolveTimer) {
    clearTimeout(room.resolveTimer);
    room.resolveTimer = null;
  }
  let maxScore = -1;
  for (const p of room.players.values()) {
    maxScore = Math.max(maxScore, Number(p.score || 0));
  }
  room.winners = Array.from(room.players.values())
    .filter((p) => Number(p.score || 0) === maxScore)
    .map((p) => ({ userId: p.userId, username: p.username, score: Number(p.score || 0) }));
  return true;
}

function memoryResolveMismatchLater(room) {
  if (room.resolveTimer) clearTimeout(room.resolveTimer);
  room.resolving = true;
  room.resolveTimer = setTimeout(() => {
    room.resolveTimer = null;
    if (room.status !== "playing") return;
    for (const i of room.revealedIndices) {
      if (room.cards[i] && !room.cards[i].matched) {
        // hidden again in public state by clearing revealed indices
      }
    }
    room.revealedIndices = [];
    room.resolving = false;
    if (room.turnOrder.length > 0) {
      room.turnCursor = (room.turnCursor + 1) % room.turnOrder.length;
      memorySetTurnByCursor(room);
    } else {
      room.turnUserId = null;
    }
    broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
  }, 1100);
}

function requireAuthPage(req, res) {
  const session = getSession(req);
  if (!session) {
    redirect(res, "/login");
    return null;
  }
  return session;
}

function requireAuthApi(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return null;
  }
  return session;
}

function clampBingoSize(size) {
  const n = Number(size);
  if (!Number.isInteger(n)) return null;
  if (n < 5 || n > 10) return null;
  return n;
}

function clampTurnSeconds(seconds) {
  const n = Number(seconds);
  const allowed = new Set([3, 5, 7, 10, 15, 20]);
  if (!Number.isInteger(n)) return null;
  if (!allowed.has(n)) return null;
  return n;
}

function clampMemoryCardCount(cardCount) {
  const n = Number(cardCount);
  if (!Number.isInteger(n)) return null;
  if (!MEMORY_CARD_COUNTS.has(n)) return null;
  return n;
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function buildTurnOrder(room) {
  // Keep insertion order (join order) from Map.
  return Array.from(room.players.keys());
}

function countHumanPlayers(room) {
  let count = 0;
  for (const id of room.players.keys()) {
    if (id !== BINGO_BOT_USER_ID) count++;
  }
  return count;
}

function removeBingoBotIfPresent(room) {
  if (!room.players.has(BINGO_BOT_USER_ID)) return false;
  room.players.delete(BINGO_BOT_USER_ID);
  room.connections.delete(BINGO_BOT_USER_ID);
  room.turnOrder = room.turnOrder.filter((id) => id !== BINGO_BOT_USER_ID);
  if (room.turnUserId === BINGO_BOT_USER_ID) {
    room.turnUserId = null;
    room.turnEndsAt = null;
  }
  return true;
}

function ensureBingoBot(room) {
  if (!room.botEnabled) return false;
  if (room.players.has(BINGO_BOT_USER_ID)) return false;
  room.players.set(BINGO_BOT_USER_ID, {
    userId: BINGO_BOT_USER_ID,
    username: BINGO_BOT_USERNAME,
    board: generateBoard(room.size),
    joinedAt: nowIso(),
    online: true,
    isBot: true,
  });
  return true;
}

function syncBingoBotForHumans(room) {
  if (!room.botEnabled) {
    removeBingoBotIfPresent(room);
    return;
  }
  const humanCount = countHumanPlayers(room);
  if (humanCount <= 1) ensureBingoBot(room);
  else removeBingoBotIfPresent(room);
}

function pickRandomRemainingNumber(room) {
  const max = room.size * room.size;
  const remaining = [];
  for (let n = 1; n <= max; n++) {
    if (!room.calledNumbers.has(n)) remaining.push(n);
  }
  if (remaining.length === 0) return null;
  return remaining[crypto.randomInt(0, remaining.length)];
}

function evaluateWinners(room) {
  const winners = [];
  for (const p of room.players.values()) {
    const lines = countCompleteLines(p.board, room.calledNumbers);
    if (lines >= room.targetLines) winners.push({ userId: p.userId, username: p.username, lines });
  }
  return winners;
}

function setTurnByCursor(room) {
  if (room.turnOrder.length === 0) {
    room.turnUserId = null;
    room.turnEndsAt = null;
    return;
  }
  room.turnCursor = ((room.turnCursor % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
  room.turnUserId = room.turnOrder[room.turnCursor];
}

function scheduleTurn(room) {
  clearTurnTimer(room);
  if (room.status !== "playing") return;
  if (!room.turnUserId) return;
  const isBotTurn = room.turnUserId === BINGO_BOT_USER_ID;
  // Human players must pick manually on their own turn.
  if (!isBotTurn) {
    room.turnEndsAt = null;
    return;
  }
  const turnMs = 1200;
  room.turnEndsAt = Date.now() + turnMs;
  room.turnTimer = setTimeout(() => {
    if (room.status !== "playing") return;
    if (!room.turnUserId) return;
    const actorUserId = room.turnUserId;
    const selectedNumber = pickRandomRemainingNumber(room);
    if (selectedNumber == null) return;
    drawNextNumber(room, {
      actorUserId,
      reason: "bot_pick",
      selectedNumber,
    });
  }, turnMs);
}

function drawNextNumber(room, { actorUserId, reason, selectedNumber }) {
  if (room.status !== "playing") return { ok: false, error: "not_playing", number: null };

  const max = room.size * room.size;
  const remaining = [];
  for (let n = 1; n <= max; n++) if (!room.calledNumbers.has(n)) remaining.push(n);

  if (remaining.length === 0) {
    room.status = "ended";
    room.winners = [];
    room.turnUserId = null;
    room.turnEndsAt = null;
    clearTurnTimer(room);
    broadcastRoom(room, "state", roomPublicState(room));
    return { ok: true, number: null };
  }

  const number = Number(selectedNumber);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    return { ok: false, error: "invalid_number", number: null };
  }
  if (room.calledNumbers.has(number)) {
    return { ok: false, error: "number_already_called", number: null };
  }
  room.calledNumbers.add(number);
  room.lastNumber = number;
  room.lastDrawByUserId = actorUserId ?? null;
  {
    const p = actorUserId ? room.players.get(actorUserId) : null;
    room.lastDrawByUsername = p ? p.username : null;
  }
  room.lastDrawReason = reason;

  const winners = evaluateWinners(room);
  if (winners.length > 0) {
    room.status = "ended";
    room.winners = winners;
    room.turnUserId = null;
    room.turnEndsAt = null;
    clearTurnTimer(room);
    broadcastRoom(room, "state", roomPublicState(room));
    return { ok: true, number };
  }

  // Advance to next player for the next turn.
  if (room.turnOrder.length > 0) {
    room.turnCursor = (room.turnCursor + 1) % room.turnOrder.length;
    setTurnByCursor(room);
    scheduleTurn(room);
  } else {
    room.turnUserId = null;
    room.turnEndsAt = null;
    clearTurnTimer(room);
  }

  broadcastRoom(room, "state", roomPublicState(room));
  return { ok: true, number };
}

async function main() {
  await loadUsers();

  const server = http.createServer(async (req, res) => {
    // Small hardening: prevent basic MIME sniffing and framing.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");

    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = u.pathname;

    // Static assets
    if (req.method === "GET" && pathname.startsWith("/static/")) {
      const rel = pathname.slice("/static/".length);
      const filePath = path.join(PUBLIC_DIR, rel);
      // Prevent path traversal
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        sendJson(res, 400, { ok: false, error: "bad_request" });
        return;
      }
      await sendFile(res, filePath);
      return;
    }

    // Pages
    if (req.method === "GET" && pathname === "/") {
      const session = getSession(req);
      redirect(res, session ? "/lobby" : "/login");
      return;
    }
    if (req.method === "GET" && pathname === "/login") {
      const session = getSession(req);
      if (session) {
        redirect(res, "/lobby");
        return;
      }
      await sendFile(res, path.join(VIEWS_DIR, "login.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/signup") {
      redirect(res, "/login");
      return;
    }
    if (req.method === "GET" && pathname === "/lobby") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "lobby.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/bingo") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "bingo.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/sudoku") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "sudoku.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/croc") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "croc.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/memory") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "memory.html"));
      return;
    }
    if (req.method === "GET" && pathname === "/gomoku") {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "gomoku.html"));
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/room/")) {
      if (!requireAuthPage(req, res)) return;
      await sendFile(res, path.join(VIEWS_DIR, "room.html"));
      return;
    }

    // SSE
    if (req.method === "GET" && pathname.startsWith("/sse/room/")) {
      const session = requireAuthApi(req, res);
      if (!session) return;
      const code = pathname.slice("/sse/room/".length).toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        sendJson(res, 404, { ok: false, error: "room_not_found" });
        return;
      }
      const player = room.players.get(session.userId);
      if (!player) {
        sendJson(res, 403, { ok: false, error: "not_in_room" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`: connected ${nowIso()}\n\n`);

      const sub = { res, userId: session.userId };
      room.subscribers.add(sub);
      room.connections.set(session.userId, (room.connections.get(session.userId) || 0) + 1);
      player.online = true;

      // Initial state for this client
      sseWrite(res, "state", roomPublicState(room));

      // Announce presence change
      broadcastRoom(room, "state", roomPublicState(room));

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${nowIso()}\n\n`);
        } catch {
          // ignore
        }
      }, 25000);

      req.on("close", () => {
        clearInterval(heartbeat);
        room.subscribers.delete(sub);
        const prev = room.connections.get(session.userId) || 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) room.connections.delete(session.userId);
        else room.connections.set(session.userId, next);

        // If no more active connections for that user, mark offline.
        if (!room.connections.has(session.userId)) {
          const p = room.players.get(session.userId);
          if (p) p.online = false;
          broadcastRoom(room, "state", roomPublicState(room));
        }
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/sse/croc/")) {
      const session = requireAuthApi(req, res);
      if (!session) return;
      const code = pathname.slice("/sse/croc/".length).toUpperCase();
      const room = crocRooms.get(code);
      if (!room) {
        sendJson(res, 404, { ok: false, error: "room_not_found" });
        return;
      }
      const player = room.players.get(session.userId);
      if (!player) {
        sendJson(res, 403, { ok: false, error: "not_in_room" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`: connected ${nowIso()}\n\n`);

      const sub = { res, userId: session.userId };
      room.subscribers.add(sub);
      room.connections.set(session.userId, (room.connections.get(session.userId) || 0) + 1);
      player.online = true;

      sseWrite(res, "state", crocRoomPublicState(room));
      broadcastCrocRoom(room, "state", crocRoomPublicState(room));

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${nowIso()}\n\n`);
        } catch {
          // ignore
        }
      }, 25000);

      req.on("close", () => {
        clearInterval(heartbeat);
        room.subscribers.delete(sub);
        const prev = room.connections.get(session.userId) || 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) room.connections.delete(session.userId);
        else room.connections.set(session.userId, next);

        if (!room.connections.has(session.userId)) {
          const p = room.players.get(session.userId);
          if (p) p.online = false;
          broadcastCrocRoom(room, "state", crocRoomPublicState(room));
        }
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/sse/memory/")) {
      const session = requireAuthApi(req, res);
      if (!session) return;
      const code = pathname.slice("/sse/memory/".length).toUpperCase();
      const room = memoryRooms.get(code);
      if (!room) {
        sendJson(res, 404, { ok: false, error: "room_not_found" });
        return;
      }
      const player = room.players.get(session.userId);
      if (!player) {
        sendJson(res, 403, { ok: false, error: "not_in_room" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`: connected ${nowIso()}\n\n`);

      const sub = { res, userId: session.userId };
      room.subscribers.add(sub);
      room.connections.set(session.userId, (room.connections.get(session.userId) || 0) + 1);
      player.online = true;

      sseWrite(res, "state", memoryRoomPublicState(room));
      broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${nowIso()}\n\n`);
        } catch {
          // ignore
        }
      }, 25000);

      req.on("close", () => {
        clearInterval(heartbeat);
        room.subscribers.delete(sub);
        const prev = room.connections.get(session.userId) || 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) room.connections.delete(session.userId);
        else room.connections.set(session.userId, next);

        if (!room.connections.has(session.userId)) {
          const p = room.players.get(session.userId);
          if (p) p.online = false;
          broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
        }
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/sse/gomoku/")) {
      const session = requireAuthApi(req, res);
      if (!session) return;
      const code = pathname.slice("/sse/gomoku/".length).toUpperCase();
      const room = gomokuRooms.get(code);
      if (!room) {
        sendJson(res, 404, { ok: false, error: "room_not_found" });
        return;
      }
      const player = room.players.get(session.userId);
      if (!player) {
        sendJson(res, 403, { ok: false, error: "not_in_room" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`: connected ${nowIso()}\n\n`);

      const sub = { res, userId: session.userId };
      room.subscribers.add(sub);
      room.connections.set(session.userId, (room.connections.get(session.userId) || 0) + 1);
      player.online = true;

      sseWrite(res, "state", gomokuRoomPublicState(room));
      broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${nowIso()}\n\n`);
        } catch {
          // ignore
        }
      }, 25000);

      req.on("close", () => {
        clearInterval(heartbeat);
        room.subscribers.delete(sub);
        const prev = room.connections.get(session.userId) || 0;
        const next = Math.max(0, prev - 1);
        if (next === 0) room.connections.delete(session.userId);
        else room.connections.set(session.userId, next);

        if (!room.connections.has(session.userId)) {
          const p = room.players.get(session.userId);
          if (p) p.online = false;
          broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
        }
      });
      return;
    }

    // API
    if (pathname.startsWith("/api/")) {
      if (req.method === "GET" && pathname === "/api/me") {
        const session = getSession(req);
        if (!session) {
          sendJson(res, 200, { ok: true, user: null });
          return;
        }
        sendJson(res, 200, { ok: true, user: { userId: session.userId, username: session.username } });
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/signup") {
        sendJson(res, 410, { ok: false, error: "signup_disabled" });
        return;
      }

      if (req.method === "POST" && pathname === "/api/login") {
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const username = normalizeUsername(body.value.username);
        if (username.length < 2 || username.length > 20) {
          sendJson(res, 400, { ok: false, error: "username_length" });
          return;
        }
        let user = userDb.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
        let created = false;
        if (!user) {
          user = {
            id: userDb.nextId++,
            username,
            passwordHash: null,
            createdAt: nowIso(),
          };
          userDb.users.push(user);
          created = true;
          await queueUserDbWrite();
        }
        setSession(res, { userId: user.id, username: user.username });
        sendJson(res, 200, { ok: true, created });
        return;
      }

      if (req.method === "POST" && pathname === "/api/logout") {
        clearSession(req, res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/croc/rooms") {
        const session = requireAuthApi(req, res);
        if (!session) return;

        let code = pickRoomCode();
        for (let i = 0; i < 10 && crocRooms.has(code); i++) code = pickRoomCode();
        if (crocRooms.has(code)) {
          sendJson(res, 500, { ok: false, error: "room_code_collision" });
          return;
        }

        const room = {
          code,
          status: "lobby",
          hostUserId: session.userId,
          createdAt: nowIso(),
          players: new Map(),
          selectedTeeth: new Set(),
          toothCountPerJaw: 20,
          trapTooth: null,
          turnOrder: [],
          turnCursor: 0,
          turnUserId: null,
          lastPickedTooth: null,
          lastPickerUserId: null,
          loserUserId: null,
          loserUsername: null,
          winnerUserId: null,
          winnerUsername: null,
          subscribers: new Set(),
          connections: new Map(),
        };
        room.players.set(session.userId, {
          userId: session.userId,
          username: session.username,
          joinedAt: nowIso(),
          online: true,
          alive: true,
        });
        crocRooms.set(code, room);
        sendJson(res, 200, { ok: true, code });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/croc/rooms/") && pathname.endsWith("/join")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/croc/rooms/".length, -"/join".length).toUpperCase();
        const room = crocRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.status !== "lobby" && !room.players.has(session.userId)) {
          sendJson(res, 409, { ok: false, error: "room_not_joinable" });
          return;
        }

        const existing = room.players.get(session.userId);
        if (!existing) {
          room.players.set(session.userId, {
            userId: session.userId,
            username: session.username,
            joinedAt: nowIso(),
            online: true,
            alive: true,
          });
        } else {
          existing.online = true;
        }
        broadcastCrocRoom(room, "state", crocRoomPublicState(room));
        sendJson(res, 200, { ok: true, room: crocRoomPublicState(room) });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/croc/rooms/") && pathname.endsWith("/leave")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/croc/rooms/".length, -"/leave".length).toUpperCase();
        const room = crocRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        const leavingWasTurn = room.turnUserId === session.userId;
        room.players.delete(session.userId);
        room.connections.delete(session.userId);
        room.turnOrder = room.turnOrder.filter((id) => id !== session.userId);

        if (room.hostUserId === session.userId) {
          const nextHost = room.players.values().next().value;
          room.hostUserId = nextHost ? nextHost.userId : null;
        }
        if (room.status === "playing" && leavingWasTurn && room.turnOrder.length > 0) {
          if (room.turnCursor >= room.turnOrder.length) room.turnCursor = 0;
          crocSetTurnByCursor(room);
        } else if (room.status === "playing" && room.turnOrder.length === 0) {
          room.status = "ended";
          room.turnUserId = null;
        }
        broadcastCrocRoom(room, "state", crocRoomPublicState(room));
        pruneCrocRoomIfEmpty(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/croc/rooms/") && pathname.endsWith("/start")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/croc/rooms/".length, -"/start".length).toUpperCase();
        const room = crocRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.hostUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "host_only" });
          return;
        }
        if (room.players.size < 2) {
          sendJson(res, 409, { ok: false, error: "need_two_players" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const toothCountPerJaw = Number(body.value.toothCountPerJaw);
        if (!Number.isInteger(toothCountPerJaw) || toothCountPerJaw < 8 || toothCountPerJaw > 20) {
          sendJson(res, 400, { ok: false, error: "invalid_tooth_count_per_jaw" });
          return;
        }
        room.status = "playing";
        room.toothCountPerJaw = toothCountPerJaw;
        room.selectedTeeth = new Set();
        room.trapTooth = crypto.randomInt(1, toothCountPerJaw * 2 + 1);
        room.loserUserId = null;
        room.loserUsername = null;
        room.winnerUserId = null;
        room.winnerUsername = null;
        for (const p of room.players.values()) p.alive = true;
        room.turnOrder = Array.from(room.players.keys());
        room.turnCursor = 0;
        crocSetTurnByCursor(room);
        room.lastPickedTooth = null;
        room.lastPickerUserId = null;
        broadcastCrocRoom(room, "state", crocRoomPublicState(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/croc/rooms/") && pathname.endsWith("/pick")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/croc/rooms/".length, -"/pick".length).toUpperCase();
        const room = crocRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.status !== "playing") {
          sendJson(res, 409, { ok: false, error: "not_playing" });
          return;
        }
        if (room.turnUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "not_your_turn" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const tooth = Number(body.value.tooth);
        const maxTooth = room.toothCountPerJaw * 2;
        if (!Number.isInteger(tooth) || tooth < 1 || tooth > maxTooth) {
          sendJson(res, 400, { ok: false, error: "invalid_tooth" });
          return;
        }
        if (room.selectedTeeth.has(tooth)) {
          sendJson(res, 409, { ok: false, error: "already_selected" });
          return;
        }
        room.selectedTeeth.add(tooth);
        room.lastPickedTooth = tooth;
        room.lastPickerUserId = session.userId;
        const picker = room.players.get(session.userId);
        if (tooth === room.trapTooth) {
          room.status = "ended";
          room.turnUserId = null;
          if (picker) picker.alive = false;
          room.loserUserId = session.userId;
          room.loserUsername = picker ? picker.username : null;
          const winner = Array.from(room.players.values()).find((p) => p.userId !== session.userId);
          room.winnerUserId = winner ? winner.userId : null;
          room.winnerUsername = winner ? winner.username : null;
          broadcastCrocRoom(room, "state", crocRoomPublicState(room));
          sendJson(res, 200, { ok: true, trap: true });
          return;
        }

        if (room.turnOrder.length > 0) {
          room.turnCursor = (room.turnCursor + 1) % room.turnOrder.length;
          crocSetTurnByCursor(room);
        } else {
          room.turnUserId = null;
        }
        broadcastCrocRoom(room, "state", crocRoomPublicState(room));
        sendJson(res, 200, { ok: true, trap: false });
        return;
      }

      if (req.method === "POST" && pathname === "/api/memory/rooms") {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const cardCount = clampMemoryCardCount(body.value.cardCount ?? 20);
        if (!cardCount) {
          sendJson(res, 400, { ok: false, error: "invalid_card_count" });
          return;
        }

        let code = pickRoomCode();
        for (let i = 0; i < 10 && memoryRooms.has(code); i++) code = pickRoomCode();
        if (memoryRooms.has(code)) {
          sendJson(res, 500, { ok: false, error: "room_code_collision" });
          return;
        }

        const room = {
          code,
          status: "lobby",
          hostUserId: session.userId,
          createdAt: nowIso(),
          cardCount,
          matchedCount: 0,
          cards: [],
          revealedIndices: [],
          resolving: false,
          resolveTimer: null,
          turnOrder: [],
          turnCursor: 0,
          turnUserId: null,
          winners: [],
          players: new Map(),
          subscribers: new Set(),
          connections: new Map(),
        };
        room.players.set(session.userId, {
          userId: session.userId,
          username: session.username,
          joinedAt: nowIso(),
          online: true,
          score: 0,
        });
        memoryRooms.set(code, room);
        sendJson(res, 200, { ok: true, code });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/memory/rooms/") && pathname.endsWith("/join")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/memory/rooms/".length, -"/join".length).toUpperCase();
        const room = memoryRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        const existing = room.players.get(session.userId);
        if (!existing) {
          if (room.status !== "lobby") {
            sendJson(res, 409, { ok: false, error: "room_not_joinable" });
            return;
          }
          if (room.players.size >= 8) {
            sendJson(res, 409, { ok: false, error: "room_full" });
            return;
          }
          room.players.set(session.userId, {
            userId: session.userId,
            username: session.username,
            joinedAt: nowIso(),
            online: true,
            score: 0,
          });
        } else {
          existing.online = true;
        }
        broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
        sendJson(res, 200, { ok: true, room: memoryRoomPublicState(room) });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/memory/rooms/") && pathname.endsWith("/leave")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/memory/rooms/".length, -"/leave".length).toUpperCase();
        const room = memoryRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }

        const leavingWasTurn = room.turnUserId === session.userId;
        room.players.delete(session.userId);
        room.connections.delete(session.userId);
        room.turnOrder = room.turnOrder.filter((id) => id !== session.userId);

        if (room.hostUserId === session.userId) {
          const nextHost = room.players.values().next().value;
          room.hostUserId = nextHost ? nextHost.userId : null;
        }

        if (room.resolveTimer) {
          clearTimeout(room.resolveTimer);
          room.resolveTimer = null;
        }
        room.revealedIndices = [];
        room.resolving = false;

        if (room.status === "playing") {
          if (room.turnOrder.length === 0) {
            room.status = "ended";
            room.turnUserId = null;
            room.winners = [];
          } else if (leavingWasTurn || !room.turnOrder.includes(room.turnUserId)) {
            if (room.turnCursor >= room.turnOrder.length) room.turnCursor = 0;
            memorySetTurnByCursor(room);
          } else {
            room.turnCursor = Math.max(0, room.turnOrder.indexOf(room.turnUserId));
          }
        }

        broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
        pruneMemoryRoomIfEmpty(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/memory/rooms/") && pathname.endsWith("/start")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/memory/rooms/".length, -"/start".length).toUpperCase();
        const room = memoryRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.hostUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "host_only" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const cardCount = clampMemoryCardCount(body.value.cardCount ?? room.cardCount);
        if (!cardCount) {
          sendJson(res, 400, { ok: false, error: "invalid_card_count" });
          return;
        }
        if (room.players.size < 1) {
          sendJson(res, 409, { ok: false, error: "no_players" });
          return;
        }

        room.status = "playing";
        room.cardCount = cardCount;
        room.cards = buildMemoryDeck(cardCount);
        room.matchedCount = 0;
        room.revealedIndices = [];
        room.resolving = false;
        room.winners = [];
        if (room.resolveTimer) {
          clearTimeout(room.resolveTimer);
          room.resolveTimer = null;
        }
        for (const p of room.players.values()) p.score = 0;
        room.turnOrder = Array.from(room.players.keys());
        room.turnCursor = 0;
        memorySetTurnByCursor(room);
        broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/memory/rooms/") && pathname.endsWith("/pick")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/memory/rooms/".length, -"/pick".length).toUpperCase();
        const room = memoryRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.status !== "playing") {
          sendJson(res, 409, { ok: false, error: "not_playing" });
          return;
        }
        if (room.turnUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "not_your_turn" });
          return;
        }
        if (room.resolving) {
          sendJson(res, 409, { ok: false, error: "resolving" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const index = Number(body.value.index);
        if (!Number.isInteger(index) || index < 0 || index >= room.cards.length) {
          sendJson(res, 400, { ok: false, error: "invalid_index" });
          return;
        }
        const card = room.cards[index];
        if (!card || card.matched) {
          sendJson(res, 409, { ok: false, error: "already_matched" });
          return;
        }
        if (room.revealedIndices.includes(index)) {
          sendJson(res, 409, { ok: false, error: "already_revealed" });
          return;
        }

        room.revealedIndices.push(index);
        if (room.revealedIndices.length === 1) {
          broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
          sendJson(res, 200, { ok: true });
          return;
        }

        const [a, b] = room.revealedIndices;
        const cardA = room.cards[a];
        const cardB = room.cards[b];
        if (cardA.countryKey === cardB.countryKey) {
          cardA.matched = true;
          cardB.matched = true;
          room.matchedCount += 1;
          room.revealedIndices = [];
          const picker = room.players.get(session.userId);
          if (picker) picker.score = Number(picker.score || 0) + 1;

          if (memoryFinalizeIfDone(room)) {
            broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
            sendJson(res, 200, { ok: true, ended: true });
            return;
          }

          broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
          sendJson(res, 200, { ok: true, matched: true });
          return;
        }

        memoryResolveMismatchLater(room);
        broadcastMemoryRoom(room, "state", memoryRoomPublicState(room));
        sendJson(res, 200, { ok: true, matched: false });
        return;
      }

      if (req.method === "POST" && pathname === "/api/gomoku/rooms") {
        const session = requireAuthApi(req, res);
        if (!session) return;

        let code = pickRoomCode();
        for (let i = 0; i < 10 && gomokuRooms.has(code); i++) code = pickRoomCode();
        if (gomokuRooms.has(code)) {
          sendJson(res, 500, { ok: false, error: "room_code_collision" });
          return;
        }

        const room = {
          code,
          status: "lobby",
          hostUserId: session.userId,
          createdAt: nowIso(),
          boardSize: GOMOKU_SIZE,
          board: Array.from({ length: GOMOKU_SIZE * GOMOKU_SIZE }, () => null),
          turnOrder: [],
          turnCursor: 0,
          turnUserId: null,
          winnerUserId: null,
          winnerUsername: null,
          winnerStone: null,
          draw: false,
          lastMoveIndex: null,
          lastMoveByUserId: null,
          players: new Map(),
          subscribers: new Set(),
          connections: new Map(),
        };
        room.players.set(session.userId, {
          userId: session.userId,
          username: session.username,
          joinedAt: nowIso(),
          online: true,
          stone: "B",
        });
        gomokuRooms.set(code, room);
        sendJson(res, 200, { ok: true, code });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/gomoku/rooms/") && pathname.endsWith("/join")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/gomoku/rooms/".length, -"/join".length).toUpperCase();
        const room = gomokuRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }

        const existing = room.players.get(session.userId);
        if (!existing) {
          if (room.status !== "lobby") {
            sendJson(res, 409, { ok: false, error: "room_not_joinable" });
            return;
          }
          if (room.players.size >= 2) {
            sendJson(res, 409, { ok: false, error: "room_full" });
            return;
          }
          const usedStones = new Set(
            Array.from(room.players.values())
              .map((p) => p.stone)
              .filter(Boolean)
          );
          room.players.set(session.userId, {
            userId: session.userId,
            username: session.username,
            joinedAt: nowIso(),
            online: true,
            stone: usedStones.has("B") ? "W" : "B",
          });
        } else {
          existing.online = true;
        }
        broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
        sendJson(res, 200, { ok: true, room: gomokuRoomPublicState(room) });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/gomoku/rooms/") && pathname.endsWith("/leave")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/gomoku/rooms/".length, -"/leave".length).toUpperCase();
        const room = gomokuRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        const leavingWasTurn = room.turnUserId === session.userId;
        room.players.delete(session.userId);
        room.connections.delete(session.userId);
        room.turnOrder = room.turnOrder.filter((id) => id !== session.userId);

        if (room.hostUserId === session.userId) {
          const nextHost = room.players.values().next().value;
          room.hostUserId = nextHost ? nextHost.userId : null;
        }

        if (room.status === "playing") {
          if (room.players.size < 2) {
            const remain = room.players.values().next().value;
            room.status = "ended";
            room.turnUserId = null;
            room.draw = false;
            room.winnerUserId = remain ? remain.userId : null;
            room.winnerUsername = remain ? remain.username : null;
            room.winnerStone = remain ? remain.stone || null : null;
          } else if (leavingWasTurn || !room.turnOrder.includes(room.turnUserId)) {
            if (room.turnCursor >= room.turnOrder.length) room.turnCursor = 0;
            gomokuSetTurnByCursor(room);
          } else {
            room.turnCursor = Math.max(0, room.turnOrder.indexOf(room.turnUserId));
          }
        }

        broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
        pruneGomokuRoomIfEmpty(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/gomoku/rooms/") && pathname.endsWith("/start")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/gomoku/rooms/".length, -"/start".length).toUpperCase();
        const room = gomokuRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.hostUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "host_only" });
          return;
        }
        if (room.players.size !== 2) {
          sendJson(res, 409, { ok: false, error: "need_two_players" });
          return;
        }

        room.status = "playing";
        room.board = Array.from({ length: room.boardSize * room.boardSize }, () => null);
        room.turnOrder = Array.from(room.players.keys()).slice(0, 2);
        room.turnCursor = 0;
        gomokuSetTurnByCursor(room);
        room.winnerUserId = null;
        room.winnerUsername = null;
        room.winnerStone = null;
        room.draw = false;
        room.lastMoveIndex = null;
        room.lastMoveByUserId = null;

        for (let i = 0; i < room.turnOrder.length; i++) {
          const id = room.turnOrder[i];
          const p = room.players.get(id);
          if (p) p.stone = i === 0 ? "B" : "W";
        }

        broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/gomoku/rooms/") && pathname.endsWith("/move")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/gomoku/rooms/".length, -"/move".length).toUpperCase();
        const room = gomokuRooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.status !== "playing") {
          sendJson(res, 409, { ok: false, error: "not_playing" });
          return;
        }
        if (room.turnUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "not_your_turn" });
          return;
        }
        const player = room.players.get(session.userId);
        if (!player || !player.stone) {
          sendJson(res, 403, { ok: false, error: "player_not_ready" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const index = Number(body.value.index);
        const maxIndex = room.boardSize * room.boardSize - 1;
        if (!Number.isInteger(index) || index < 0 || index > maxIndex) {
          sendJson(res, 400, { ok: false, error: "invalid_index" });
          return;
        }
        if (room.board[index]) {
          sendJson(res, 409, { ok: false, error: "occupied" });
          return;
        }

        room.board[index] = player.stone;
        room.lastMoveIndex = index;
        room.lastMoveByUserId = session.userId;

        if (gomokuHasFive(room.board, room.boardSize, index, player.stone)) {
          room.status = "ended";
          room.turnUserId = null;
          room.draw = false;
          room.winnerUserId = player.userId;
          room.winnerUsername = player.username;
          room.winnerStone = player.stone;
          broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
          sendJson(res, 200, { ok: true, ended: true });
          return;
        }

        const boardFull = room.board.every((v) => Boolean(v));
        if (boardFull) {
          room.status = "ended";
          room.turnUserId = null;
          room.draw = true;
          room.winnerUserId = null;
          room.winnerUsername = null;
          room.winnerStone = null;
          broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
          sendJson(res, 200, { ok: true, ended: true, draw: true });
          return;
        }

        room.turnCursor = (room.turnCursor + 1) % room.turnOrder.length;
        gomokuSetTurnByCursor(room);
        broadcastGomokuRoom(room, "state", gomokuRoomPublicState(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/rooms") {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const size = clampBingoSize(body.value.size);
        if (!size) {
          sendJson(res, 400, { ok: false, error: "invalid_size" });
          return;
        }
        const botEnabled = body.value.vsComputer !== false;

        let code = pickRoomCode();
        for (let i = 0; i < 10 && rooms.has(code); i++) code = pickRoomCode();
        if (rooms.has(code)) {
          sendJson(res, 500, { ok: false, error: "room_code_collision" });
          return;
        }

        const room = {
          code,
          size,
          targetLines: 5,
          drawTimeoutSeconds: 10,
          status: "lobby",
          hostUserId: session.userId,
          botEnabled,
          createdAt: nowIso(),
          players: new Map(),
          calledNumbers: new Set(),
          lastNumber: null,
          winners: [],
          turnOrder: [],
          turnCursor: 0,
          turnUserId: null,
          turnEndsAt: null,
          turnTimer: null,
          lastDrawByUserId: null,
          lastDrawByUsername: null,
          lastDrawReason: null,
          subscribers: new Set(),
          connections: new Map(), // userId -> count
        };

        const hostPlayer = {
          userId: session.userId,
          username: session.username,
          board: generateBoard(size),
          joinedAt: nowIso(),
          online: true,
        };
        room.players.set(session.userId, hostPlayer);
        rooms.set(code, room);

        sendJson(res, 200, { ok: true, code });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/rooms/") && pathname.endsWith("/join")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/rooms/".length, -"/join".length).toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        const existing = room.players.get(session.userId);
        if (!existing) {
          if (room.status !== "lobby") {
            sendJson(res, 409, { ok: false, error: "room_not_joinable" });
            return;
          }
          if (room.botEnabled && room.players.has(BINGO_BOT_USER_ID)) {
            removeBingoBotIfPresent(room);
          }
          if (countHumanPlayers(room) >= 8) {
            sendJson(res, 409, { ok: false, error: "room_full" });
            return;
          }
          room.players.set(session.userId, {
            userId: session.userId,
            username: session.username,
            board: generateBoard(room.size),
            joinedAt: nowIso(),
            online: true,
          });
        } else {
          existing.online = true;
        }

        broadcastRoom(room, "state", roomPublicState(room));
        const p = room.players.get(session.userId);
        sendJson(res, 200, { ok: true, room: roomPublicState(room), board: p.board });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/rooms/") && pathname.endsWith("/leave")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/rooms/".length, -"/leave".length).toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        const leavingWasTurn = room.turnUserId === session.userId;
        room.players.delete(session.userId);
        room.connections.delete(session.userId);
        room.turnOrder = room.turnOrder.filter((id) => id !== session.userId);
        syncBingoBotForHumans(room);

        if (room.hostUserId === session.userId) {
          const nextHost = Array.from(room.players.values()).find((p) => !p.isBot);
          room.hostUserId = nextHost ? nextHost.userId : null;
        }

        if (room.status === "playing") {
          room.turnOrder = buildTurnOrder(room);
          if (room.turnOrder.length === 0) {
            room.status = "ended";
            room.turnUserId = null;
            room.turnEndsAt = null;
            clearTurnTimer(room);
          } else if (leavingWasTurn) {
            if (room.turnCursor >= room.turnOrder.length) room.turnCursor = 0;
            setTurnByCursor(room);
            scheduleTurn(room);
          } else if (!room.turnOrder.includes(room.turnUserId)) {
            if (room.turnCursor >= room.turnOrder.length) room.turnCursor = 0;
            setTurnByCursor(room);
            scheduleTurn(room);
          } else {
            room.turnCursor = room.turnOrder.indexOf(room.turnUserId);
            scheduleTurn(room);
          }
        }

        broadcastRoom(room, "state", roomPublicState(room));
        pruneRoomIfEmpty(room);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/rooms/") && pathname.endsWith("/start")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/rooms/".length, -"/start".length).toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.hostUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "host_only" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const timeout = clampTurnSeconds(body.value.drawTimeoutSeconds);
        if (!timeout) {
          sendJson(res, 400, { ok: false, error: "invalid_draw_timeout_seconds" });
          return;
        }
        syncBingoBotForHumans(room);
        if (countHumanPlayers(room) < 1) {
          sendJson(res, 409, { ok: false, error: "no_players" });
          return;
        }
        room.status = "playing";
        room.drawTimeoutSeconds = timeout;
        room.calledNumbers = new Set();
        room.lastNumber = null;
        room.winners = [];
        room.lastDrawByUserId = null;
        room.lastDrawByUsername = null;
        room.lastDrawReason = null;
        room.turnOrder = buildTurnOrder(room);
        room.turnCursor = 0;
        setTurnByCursor(room);
        scheduleTurn(room);
        broadcastRoom(room, "state", roomPublicState(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/rooms/") && pathname.endsWith("/draw")) {
        const session = requireAuthApi(req, res);
        if (!session) return;
        const code = pathname.slice("/api/rooms/".length, -"/draw".length).toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendJson(res, 404, { ok: false, error: "room_not_found" });
          return;
        }
        if (room.status !== "playing") {
          sendJson(res, 409, { ok: false, error: "not_playing" });
          return;
        }
        if (!room.players.has(session.userId)) {
          sendJson(res, 403, { ok: false, error: "not_in_room" });
          return;
        }
        if (room.turnUserId !== session.userId) {
          sendJson(res, 403, { ok: false, error: "not_your_turn" });
          return;
        }
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { ok: false, error: body.error });
          return;
        }
        const selectedNumber = Number(body.value.number);
        const result = drawNextNumber(room, {
          actorUserId: session.userId,
          reason: "manual_pick",
          selectedNumber,
        });
        if (!result.ok) {
          sendJson(res, 409, { ok: false, error: result.error || "draw_failed" });
          return;
        }
        sendJson(res, 200, { ok: true, number: result.number });
        return;
      }

      sendJson(res, 404, { ok: false, error: "api_not_found" });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Bingo server listening on http://localhost:${PORT} (bind ${HOST})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
