const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // The browser and game server are served from the same origin by default.
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(",").map(s => s.trim()) } : undefined,
  pingInterval: 25000,
  pingTimeout: 20000,
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6
});

const PORT = readIntEnv("PORT", 3000, 1, 65535);
const HARD_MAX_PLAYERS_PER_ROOM = 256;
// Adjust these environment variables to match the CPU/RAM/network capacity of the host.
const MAX_PLAYERS_PER_ROOM = readIntEnv("MAX_PLAYERS_PER_ROOM", 64, 2, HARD_MAX_PLAYERS_PER_ROOM);
const MAX_TOTAL_PLAYERS = readIntEnv("MAX_TOTAL_PLAYERS", Math.max(500, MAX_PLAYERS_PER_ROOM), 1, 20000);
const SNAPSHOT_RATE_HZ = readIntEnv("SNAPSHOT_RATE_HZ", 10, 2, 20);
const SIMULATION_RATE_HZ = readIntEnv("SIMULATION_RATE_HZ", 20, 10, 60);
const rooms = new Map();
const VALID_CAR_MODELS = new Set([
  "supra", "gtr", "porsche911", "huracan", "mustang", "bmwm4"
]);
function cleanCarModel(value) {
  const model = String(value || "supra");
  return VALID_CAR_MODELS.has(model) ? model : "supra";
}

app.use(express.static("public", { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/api/config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const candidates = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 192, 224, 256];
  const roomOptions = [...new Set([...candidates.filter(n => n <= MAX_PLAYERS_PER_ROOM), MAX_PLAYERS_PER_ROOM])].sort((a, b) => a - b);
  res.json({
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    maxTotalPlayers: MAX_TOTAL_PLAYERS,
    snapshotRateHz: SNAPSHOT_RATE_HZ,
    simulationRateHz: SIMULATION_RATE_HZ,
    roomOptions
  });
});
app.get("/health", (_req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  activePlayers: countPlayers(),
  maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
  maxTotalPlayers: MAX_TOTAL_PLAYERS,
  snapshotRateHz: SNAPSHOT_RATE_HZ
}));

function readIntEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function cleanName(value) {
  const name = String(value || "سائق").replace(/[<>]/g, "").trim().slice(0, 16);
  return name || "سائق";
}
function colorFor(index) {
  const palette = ["#ff3b5c", "#31b7ff", "#ffca3a", "#8d5cff", "#2fe6a6", "#ff8736",
    "#f062d0", "#b6e34b", "#64dfdf", "#f28482", "#a0c4ff", "#caffbf"];
  if (index < palette.length) return palette[index];
  // Golden-angle colors keep large lobbies visually distinguishable.
  const hue = Math.round((index * 137.508) % 360);
  return hslToHex(hue, 78, 62);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function countPlayers() {
  let total = 0;
  for (const room of rooms.values()) total += room.players.size;
  return total;
}
function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function makePlayer(id, name, index, modelId = "supra") {
  return {
    id,
    name: cleanName(name),
    color: colorFor(index),
    modelId: cleanCarModel(modelId),
    ready: index === 0,
    finished: false,
    finishTime: null,
    input: { steer: 0, throttle: false, brake: false, handbrake: false },
    state: { lane: 0.5, progress: 0, speed: 0, boost: 0 }
  };
}
function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, modelId: p.modelId, ready: p.ready,
      finished: p.finished, finishTime: p.finishTime
    }))
  };
}
function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function callbackSafely(callback, payload) {
  if (typeof callback === "function") callback(payload);
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  emitRoom(room);
}
function getRoomPlayer(socket) {
  const room = rooms.get(socket.data.roomCode);
  return { room, player: room?.players.get(socket.id) };
}

io.on("connection", socket => {
  socket.data.roomCode = null;

  socket.on("room:create", (payload = {}, callback) => {
    leaveRoom(socket);
    if (countPlayers() >= MAX_TOTAL_PLAYERS) {
      return callbackSafely(callback, { ok: false, error: `الخادم وصل إلى الحد الحالي (${MAX_TOTAL_PLAYERS} لاعبًا). جرّب لاحقًا.` });
    }

    const requested = Number(payload.maxPlayers);
    const selected = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : Math.min(32, MAX_PLAYERS_PER_ROOM);
    const room = {
      code: makeCode(),
      hostId: socket.id,
      status: "waiting",
      maxPlayers: clamp(selected, 2, MAX_PLAYERS_PER_ROOM),
      players: new Map(),
      createdAt: Date.now(),
      startAt: 0
    };
    room.players.set(socket.id, makePlayer(socket.id, payload.name, 0, payload.modelId));
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    callbackSafely(callback, { ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:join", (payload = {}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return callbackSafely(callback, { ok: false, error: "الغرفة غير موجودة. راجع كود الدخول." });
    if (socket.data.roomCode === code && room.players.has(socket.id)) {
      return callbackSafely(callback, { ok: true, room: publicRoom(room) });
    }
    if (room.status !== "waiting") return callbackSafely(callback, { ok: false, error: "السباق بدأ بالفعل ولا يقبل لاعبين جددًا." });
    if (room.players.size >= room.maxPlayers) return callbackSafely(callback, { ok: false, error: `الغرفة ممتلئة (${room.maxPlayers} لاعبًا كحد أقصى).` });

    leaveRoom(socket);
    if (countPlayers() >= MAX_TOTAL_PLAYERS) {
      return callbackSafely(callback, { ok: false, error: `الخادم وصل إلى الحد الحالي (${MAX_TOTAL_PLAYERS} لاعبًا).` });
    }
    // Re-check after leaving any previous room.
    if (!rooms.has(code) || room.status !== "waiting" || room.players.size >= room.maxPlayers) {
      return callbackSafely(callback, { ok: false, error: "لم تعد هناك مساحة متاحة في هذه الغرفة." });
    }
    room.players.set(socket.id, makePlayer(socket.id, payload.name, room.players.size, payload.modelId));
    socket.join(code);
    socket.data.roomCode = code;
    callbackSafely(callback, { ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("player:ready", (ready, callback) => {
    const { room, player } = getRoomPlayer(socket);
    if (!room || !player || room.status !== "waiting") return callbackSafely(callback, { ok: false });
    player.ready = !!ready;
    emitRoom(room);
    callbackSafely(callback, { ok: true });
  });

  socket.on("race:start", (_unused, callback) => {
    const { room } = getRoomPlayer(socket);
    if (!room) return callbackSafely(callback, { ok: false, error: "لا توجد غرفة." });
    if (room.hostId !== socket.id) return callbackSafely(callback, { ok: false, error: "مضيف الغرفة فقط يستطيع بدء السباق." });
    if (room.status === "racing") return callbackSafely(callback, { ok: false, error: "السباق جارٍ بالفعل." });

    room.status = "racing";
    room.startAt = Date.now() + 3500;
    for (const p of room.players.values()) {
      p.finished = false;
      p.finishTime = null;
      p.state = { lane: 0.5, progress: 0, speed: 0, boost: 0 };
      p.input = { steer: 0, throttle: false, brake: false, handbrake: false };
    }
    io.to(room.code).emit("race:countdown", { startAt: room.startAt, duration: 3500 });
    emitRoom(room);
    callbackSafely(callback, { ok: true });
  });

  // Clients transmit only control inputs; the server owns speed, boost duration and progress.
  socket.on("player:input", input => {
    const { room, player } = getRoomPlayer(socket);
    if (!room || !player || room.status !== "racing" || player.finished) return;
    player.input = {
      steer: clamp(Number(input?.steer) || 0, -1, 1),
      throttle: input?.throttle ? 1 : 0,
      brake: input?.brake ? 1 : 0,
      handbrake: input?.handbrake ? 1 : 0
    };
  });

  socket.on("player:boost", () => {
    const { room, player } = getRoomPlayer(socket);
    if (!room || !player || room.status !== "racing" || player.finished) return;
    if (player.state.boost <= 0) player.state.boost = 2.5;
  });

  // Finish is determined by server simulation; client reports are intentionally ignored.
  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

let previousTick = Date.now();
let previousSnapshot = 0;
const simulationIntervalMs = Math.round(1000 / SIMULATION_RATE_HZ);
const snapshotIntervalMs = 1000 / SNAPSHOT_RATE_HZ;
setInterval(() => {
  const now = Date.now();
  const dt = clamp((now - previousTick) / 1000, 0, 0.1);
  previousTick = now;

  for (const room of rooms.values()) {
    if (room.status !== "racing" || now < room.startAt) continue;
    for (const p of room.players.values()) {
      if (p.finished) continue;
      const s = p.state;
      const input = p.input;
      const boostFactor = s.boost > 0 ? 1.65 : 1;
      // Steering is simulated on the server to keep lanes consistent for every player.
      const steeringRate = (1.2 + s.speed * 1.6) * (input.handbrake ? 1.25 : 1);
      s.lane = clamp(s.lane + input.steer * steeringRate * dt, -2.5, 2.5);
      s.boost = Math.max(0, s.boost - dt);
      if (input.handbrake) s.speed = Math.max(0, s.speed - 1.55 * dt);
      else if (input.brake) s.speed = Math.max(0, s.speed - 1.25 * dt);
      else if (input.throttle) s.speed = Math.min(1, s.speed + 0.82 * dt);
      else s.speed = Math.max(0, s.speed - 0.2 * dt);
      s.progress = Math.min(1, s.progress + (s.speed * boostFactor * dt) / 45);
      if (s.progress >= 1) {
        p.finished = true;
        p.finishTime = now;
        p.state.speed = 0;
        io.to(room.code).emit("race:finish", { id: p.id, name: p.name, finishTime: p.finishTime });
      }
    }
    if ([...room.players.values()].every(p => p.finished)) {
      room.status = "finished";
      emitRoom(room);
    }
  }

  // Lower snapshot frequency limits fan-out/network use in larger rooms.
  if (now - previousSnapshot >= snapshotIntervalMs) {
    previousSnapshot = now;
    for (const room of rooms.values()) {
      if (room.status !== "racing") continue;
      const players = [...room.players.values()].map(p => ({
        id: p.id,
        modelId: p.modelId,
        color: p.color,
        lane: p.state.lane,
        progress: p.state.progress,
        speed: p.state.speed,
        boost: p.state.boost,
        finished: p.finished,
        finishTime: p.finishTime
      }));
      io.to(room.code).emit("race:state", { now, players });
    }
  }
}, simulationIntervalMs);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Turbo Clash Online running on port ${PORT}`);
  console.log(`Room capacity: ${MAX_PLAYERS_PER_ROOM}; total active player cap: ${MAX_TOTAL_PLAYERS}`);
  console.log(`Simulation: ${SIMULATION_RATE_HZ} Hz; network snapshots: ${SNAPSHOT_RATE_HZ} Hz`);
});
