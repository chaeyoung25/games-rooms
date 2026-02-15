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

function roomPublicState(room) {
  return {
    code: room.code,
    size: room.size,
    targetLines: room.targetLines,
    status: room.status,
    hostUserId: room.hostUserId,
    createdAt: room.createdAt,
    players: Array.from(room.players.values()).map((p) => ({
      userId: p.userId,
      username: p.username,
      online: Boolean(p.online),
      joinedAt: p.joinedAt,
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

function pruneRoomIfEmpty(room) {
  if (room.players.size > 0) return;
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

function crocSetTurnByCursor(room) {
  if (room.turnOrder.length === 0) {
    room.turnUserId = null;
    return;
  }
  room.turnCursor = ((room.turnCursor % room.turnOrder.length) + room.turnOrder.length) % room.turnOrder.length;
  room.turnUserId = room.turnOrder[room.turnCursor];
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
  room.turnEndsAt = null;
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
          if (room.players.size >= 8) {
            sendJson(res, 409, { ok: false, error: "room_full" });
            return;
          }
          if (room.status !== "lobby") {
            sendJson(res, 409, { ok: false, error: "room_not_joinable" });
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

        if (room.hostUserId === session.userId) {
          const nextHost = room.players.values().next().value;
          room.hostUserId = nextHost ? nextHost.userId : null;
        }

        if (room.status === "playing") {
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
        if (room.players.size < 1) {
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
