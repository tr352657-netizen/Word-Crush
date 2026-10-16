import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const socket = io();
const $ = id => document.getElementById(id);
const lobby = $("lobby"), roomPanel = $("roomPanel"), racePanel = $("racePanel");
const lobbyError = $("lobbyError"), roomError = $("roomError");
let currentRoom = null, roomState = null, racing = false;
let serverConfig = {
  maxPlayersPerRoom: 64,
  maxTotalPlayers: 500,
  snapshotRateHz: 10,
  roomOptions: [2, 4, 8, 12, 16, 24, 32, 48, 64]
};
let renderer, scene, camera, clock, playerCar, roadGroup, worldGroup;
let cars = new Map(), obstacles = [], boosts = [], keys = {};
let lane = 0.5, speed = 0, progress = 0, boostTime = 0, steerSmoothed = 0;
let raceStartAt = 0, lastInputSent = 0, lastStateReceivedAt = 0, boostWasDown = false;
const TRACK_LENGTH = 1800, LANE_WIDTH = 3.1, LANE_MIN = -2.5, LANE_MAX = 2.5;
const VEHICLES = {
  supra: { name: "Toyota GR Supra MK5", description: "كوبيه منخفضة بغطاء طويل، سقف أسود ومؤخرة رياضية.", width: 1.52, length: 2.65, cabinZ: -0.03, cabinWidth: .76, cabinLength: .91, cabinHeight: .39, hood: .98, grille: "wide", lights: "sweep", wing: "lip", roof: 0x182230, style: "coupe" },
  gtr: { name: "Nissan GT-R R35", description: "هيكل عريض، مقدمة هجومية وجناح خلفي واضح.", width: 1.62, length: 2.72, cabinZ: .07, cabinWidth: .75, cabinLength: .94, cabinHeight: .42, hood: .91, grille: "wide", lights: "sharp", wing: "high", roof: 0x152031, style: "sport" },
  porsche911: { name: "Porsche 911 GT3", description: "أنف قصير ومصابيح دائرية وسقف كوبيه انسيابي.", width: 1.55, length: 2.60, cabinZ: .12, cabinWidth: .71, cabinLength: .95, cabinHeight: .42, hood: .71, grille: "low", lights: "round", wing: "high", roof: 0x26303b, style: "rounded" },
  huracan: { name: "Lamborghini Huracán", description: "سوبركار عريضة ومنخفضة بمقدمة إسفينية ومداخل هواء جانبية.", width: 1.66, length: 2.70, cabinZ: -.02, cabinWidth: .70, cabinLength: .79, cabinHeight: .34, hood: 1.06, grille: "angular", lights: "slim", wing: "none", roof: 0x131820, style: "wedge" },
  mustang: { name: "Ford Mustang GT", description: "سيارة عضلات أمريكية بغطاء طويل وشبك أمامي عريض.", width: 1.68, length: 2.82, cabinZ: .20, cabinWidth: .76, cabinLength: .81, cabinHeight: .44, hood: 1.12, grille: "muscle", lights: "triple", wing: "lip", roof: 0x171b22, style: "muscle" },
  bmwm4: { name: "BMW M4 Competition", description: "كوبيه عريضة بسقف منخفض وشبك أمامي مزدوج مميز.", width: 1.65, length: 2.75, cabinZ: .10, cabinWidth: .75, cabinLength: .92, cabinHeight: .43, hood: .94, grille: "kidney", lights: "angular", wing: "lip", roof: 0x171c25, style: "coupe" }
};
function selectedCarModel() { return VEHICLES[$("carModel")?.value] ? $("carModel").value : "supra"; }
$("carModel").addEventListener("change", () => {
  const v = VEHICLES[selectedCarModel()];
  $("carDescription").textContent = `${v.name}: ${v.description}`;
});
$("carDescription").textContent = `${VEHICLES.supra.name}: ${VEHICLES.supra.description}`;

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
function cleanName() { return $("playerName").value.trim().slice(0, 16) || "سائق"; }
function showLobbyError(msg) { lobbyError.textContent = msg || ""; }
function showRoomError(msg) { roomError.textContent = msg || ""; }
function arabicPlayerCount(n) {
  if (n === 2) return "لاعبان";
  if (n === 1) return "لاعب واحد";
  return `${n} لاعبًا`;
}

async function loadServerConfig() {
  const select = $("maxPlayers");
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("config endpoint unavailable");
    const config = await response.json();
    if (!Number.isFinite(config.maxPlayersPerRoom) || !Array.isArray(config.roomOptions)) {
      throw new Error("invalid config");
    }
    serverConfig = { ...serverConfig, ...config };
    select.replaceChildren();
    const options = [...new Set(config.roomOptions.map(Number).filter(n => n >= 2 && n <= config.maxPlayersPerRoom))].sort((a, b) => a - b);
    if (!options.includes(config.maxPlayersPerRoom)) options.push(config.maxPlayersPerRoom);
    options.forEach(n => {
      const option = document.createElement("option");
      option.value = String(n);
      option.textContent = `${arabicPlayerCount(n)} — سعة الغرفة`;
      select.append(option);
    });
    const preferred = options.includes(32) ? 32 : options.includes(16) ? 16 : options[options.length - 1];
    select.value = String(preferred);
    select.disabled = false;
    $("capacityHelp").textContent = `الخادم يسمح حتى ${config.maxPlayersPerRoom} لاعبًا بالغرفة، وإجمالي ${config.maxTotalPlayers} لاعب متصل في جميع الغرف. السعة الفعلية تعتمد على قوة الاستضافة والأجهزة.`;
  } catch (error) {
    // Keep the game usable for local testing if the config route is unavailable.
    select.replaceChildren();
    [2, 4, 8, 12, 16, 24, 32, 48, 64].forEach(n => {
      const option = document.createElement("option");
      option.value = String(n); option.textContent = `${arabicPlayerCount(n)} — سعة الغرفة`;
      if (n > serverConfig.maxPlayersPerRoom) option.disabled = true;
      select.append(option);
    });
    select.value = String(Math.min(32, serverConfig.maxPlayersPerRoom));
    select.disabled = false;
    $("capacityHelp").textContent = "تعذر قراءة إعدادات الخادم؛ سيطبّق الخادم الحد الفعلي عند إنشاء الغرفة.";
  }
}
loadServerConfig();

$("createBtn").addEventListener("click", () => {
  showLobbyError("");
  if (!$("maxPlayers").value) return showLobbyError("انتظر حتى يتم تحميل إعدادات سعة الغرف.");
  socket.emit("room:create", {
    name: cleanName(),
    modelId: selectedCarModel(),
    maxPlayers: Number($("maxPlayers").value)
  }, result => {
    if (!result?.ok) return showLobbyError(result?.error || "تعذر إنشاء الغرفة.");
    enterRoom(result.room);
  });
});
$("joinBtn").addEventListener("click", () => {
  showLobbyError("");
  const code = $("roomCode").value.trim().toUpperCase();
  if (!code) return showLobbyError("اكتب كود الغرفة أولًا.");
  socket.emit("room:join", { code, name: cleanName(), modelId: selectedCarModel() }, result => {
    if (!result?.ok) return showLobbyError(result?.error || "تعذر دخول الغرفة.");
    enterRoom(result.room);
  });
});
$("roomCode").addEventListener("input", e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
});
$("copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentRoom?.code || "");
    $("copyBtn").textContent = "تم النسخ ✓";
    setTimeout(() => $("copyBtn").textContent = "نسخ الكود", 1500);
  } catch {
    $("roomError").textContent = "انسخ الكود يدويًا: " + (currentRoom?.code || "");
  }
});
$("leaveBtn").addEventListener("click", leaveRoom);
$("exitRaceBtn").addEventListener("click", leaveRoom);
$("readyBtn").addEventListener("click", () => {
  const me = roomState?.players?.find(p => p.id === socket.id);
  socket.emit("player:ready", !me?.ready);
});
$("startBtn").addEventListener("click", () => {
  socket.emit("race:start", {}, result => {
    if (!result?.ok) showRoomError(result?.error || "تعذر بدء السباق.");
  });
});

function enterRoom(room) {
  currentRoom = room;
  roomState = room;
  hide(lobby); show(roomPanel); hide(racePanel);
  $("roomCodeDisplay").textContent = room.code;
  renderRoom(room);
  showRoomError("");
}
function leaveRoom() {
  socket.emit("room:leave");
  currentRoom = null; roomState = null; racing = false;
  keys = {};
  disposeGame();
  hide(roomPanel); hide(racePanel); show(lobby);
  showLobbyError(""); showRoomError("");
}
socket.on("room:update", room => {
  if (!currentRoom || room.code !== currentRoom.code) return;
  roomState = room;
  renderRoom(room);
  if (room.status === "finished" && !racePanel.classList.contains("hidden")) {
    showToast("🏆 انتهى السباق! راجع الترتيب.");
  }
});
socket.on("race:countdown", data => {
  if (!currentRoom) return;
  hide(roomPanel); show(racePanel);
  racing = true;
  initGame();
  raceStartAt = data.startAt;
  show($("countdown"));
});
socket.on("race:state", data => {
  if (!racing) return;
  const metadata = new Map((roomState?.players || []).map(p => [p.id, p]));
  const snapshot = (data.players || []).map(p => ({ ...(metadata.get(p.id) || {}), ...p }));
  updateRemoteCars(snapshot);
  updateLeaderboard(snapshot);
  const me = snapshot.find(p => p.id === socket.id);
  if (me) {
    progress = me.progress || 0; // official server progress
    speed = me.speed || 0;
    boostTime = me.boost || 0;
    if (Number.isFinite(me.lane)) lane = THREE.MathUtils.lerp(lane, me.lane, 0.32);
    lastStateReceivedAt = performance.now();
    $("speedValue").textContent = Math.round(speed * 220);
    $("progressValue").textContent = Math.floor(progress * 100) + "%";
    const sorted = sortPlayers(snapshot);
    $("positionValue").textContent = `${sorted.findIndex(p => p.id === socket.id) + 1}/${sorted.length}`;
  }
});
socket.on("race:finish", data => {
  showToast(`🏁 ${data.name} وصل إلى خط النهاية!`);
});
socket.on("disconnect", () => {
  if (currentRoom) showRoomError("انقطع الاتصال بالخادم. جارٍ إعادة الاتصال...");
});
socket.on("connect", () => {
  if (currentRoom) showRoomError("اتصلت الشبكة مجددًا. إذا لم تعد للغرفة، اطلب من المضيف إرسال كود جديد.");
});

function renderRoom(room) {
  $("roomCodeDisplay").textContent = room.code;
  $("playerCount").textContent = `${room.players.length} / ${room.maxPlayers}`;
  const list = $("playerList");
  list.replaceChildren();
  room.players.forEach(p => {
    const item = document.createElement("div"); item.className = "player-card";
    const dot = document.createElement("span"); dot.className = "player-dot"; dot.style.background = p.color;
    const meta = document.createElement("div"); meta.className = "player-meta";
    const name = document.createElement("span"); name.className = "player-name";
    name.textContent = p.name + (p.id === socket.id ? " (أنت)" : "");
    const carName = document.createElement("span"); carName.className = "player-car-name";
    carName.textContent = VEHICLES[p.modelId]?.name || "Toyota GR Supra MK5";
    const status = document.createElement("span"); status.className = "player-status";
    status.textContent = p.finished ? "وصل 🏁" : p.ready ? "جاهز ✓" : "ينتظر";
    meta.append(name, carName); item.append(dot, meta, status); list.append(item);
  });
  const me = room.players.find(p => p.id === socket.id);
  $("readyBtn").textContent = me?.ready ? "إلغاء الجاهزية" : "أنا جاهز ✓";
  $("readyBtn").disabled = room.status !== "waiting";
  $("startBtn").classList.toggle("hidden", room.hostId !== socket.id || room.status !== "waiting");
  $("roomHint").textContent = room.hostId === socket.id
    ? `أنت مضيف الغرفة. السعة ${room.maxPlayers} لاعبًا. يمكنك بدء السباق من هذه الغرفة.`
    : `انتظر المضيف ليبدأ السباق. سعة الغرفة ${room.maxPlayers} لاعبًا.`;
}

function initGame() {
  if (renderer) disposeGame();
  const canvas = $("gameCanvas"), viewport = $("gameViewport");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8bd2ff);
  scene.fog = new THREE.Fog(0x8bd2ff, 70, 240);
  camera = new THREE.PerspectiveCamera(66, viewport.clientWidth / viewport.clientHeight, .1, 500);
  camera.position.set(0, 7, 15);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  clock = new THREE.Clock();
  scene.add(new THREE.HemisphereLight(0xdff5ff, 0x55703e, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(-20, 35, 15); sun.castShadow = true; scene.add(sun);
  worldGroup = new THREE.Group(); scene.add(worldGroup);
  roadGroup = new THREE.Group(); worldGroup.add(roadGroup);
  createWorld();
  const me = roomState?.players?.find(p => p.id === socket.id);
  lane = Number.isFinite(me?.lane) ? me.lane : 0.5;
  playerCar = makeCar(me?.modelId || selectedCarModel(), me?.color || "#ff3b5c", true);
  playerCar.position.set(lane * LANE_WIDTH, 0, 7);
  scene.add(playerCar);
  speed = 0; progress = 0; boostTime = 0; steerSmoothed = 0;
  cars = new Map(); obstacles = []; boosts = [];
  lastStateReceivedAt = performance.now();
  window.addEventListener("resize", onResize);
  requestAnimationFrame(animate);
}
function disposeGame() {
  window.removeEventListener("resize", onResize);
  if (renderer) { renderer.dispose(); renderer = null; }
  scene = camera = clock = playerCar = roadGroup = worldGroup = null;
  cars.clear(); obstacles = []; boosts = [];
}
function onResize() {
  if (!renderer || !camera) return;
  const w = $("gameViewport").clientWidth, h = $("gameViewport").clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false);
}
function mat(color, roughness = .7, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
function box(parent, x, y, z, sx, sy, sz, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
function createWorld() {
  const grass = mat(0x3b9b48), road = mat(0x353a45), stripe = mat(0xf4f6fa), red = mat(0xf24c58);
  const white = mat(0xffffff), wood = mat(0x875b31);
  box(worldGroup, 0, -.65, -80, 220, 1, 300, grass);
  box(roadGroup, 0, -.05, -75, LANE_WIDTH * 6, .25, 250, road);
  // Six lanes: five dashed dividers and two outside edges.
  for (let i = -3; i <= 3; i++) {
    if (i === -3 || i === 3) box(roadGroup, i * LANE_WIDTH, -.01, -75, .22, .12, 250, white);
    else for (let z = 40; z > -200; z -= 9) box(roadGroup, i * LANE_WIDTH, -.005, z, .07, .025, 4.2, stripe);
  }
  for (let z = 35; z > -195; z -= 12) {
    for (const side of [-1, 1]) {
      box(worldGroup, side * 11, .2, z, .45, .5, .45, side === -1 ? red : white);
      if (Math.abs(z) % 36 < 1) {
        box(worldGroup, side * 15, 1.2, z, .65, 2.4, .65, wood);
        const crown = new THREE.Mesh(new THREE.ConeGeometry(2.2, 5, 7), mat(0x197342));
        crown.position.set(side * 15, 4, z); crown.castShadow = true; worldGroup.add(crown);
      }
    }
  }
  // Branching sections that visually suggest left/right route choices.
  for (const z of [-35, -85, -135]) {
    const fork = new THREE.Group(); fork.position.z = z;
    box(fork, -5.5, .02, 0, 8, .12, 7, road);
    box(fork, 5.5, .02, -3, 8, .12, 7, road);
    box(fork, 0, .05, 0, .3, .18, 7, red); worldGroup.add(fork);
    const arrow1 = makeArrow(0x8affd4); arrow1.position.set(-5.5, .25, z); worldGroup.add(arrow1);
    const arrow2 = makeArrow(0xffca3a); arrow2.position.set(5.5, .25, z - 3); worldGroup.add(arrow2);
  }
  // Demo obstacles and boost pickups. Each client currently generates its own layout.
  const obstacleLanes = [-1.5, 1.5, 0.5, -2.5, 2.5, -0.5, 1.5];
  for (const [index, z] of [-18, -42, -68, -96, -122, -151, -177].entries()) {
    const laneIndex = obstacleLanes[index];
    const obstacle = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.65, .7, 1.2, 10), mat(0xff7a26));
    barrel.position.y = .6; barrel.castShadow = true; obstacle.add(barrel);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(.67, .67, .2, 10), white);
    band.position.y = .7; obstacle.add(band);
    obstacle.position.set(laneIndex * LANE_WIDTH, 0, z);
    obstacle.userData = { lane: laneIndex, z, hit: false };
    worldGroup.add(obstacle); obstacles.push(obstacle);
  }
  const boostLanes = [0.5, -1.5, 2.5, -0.5, 1.5, -2.5];
  for (const [index, z] of [-28, -58, -88, -118, -148, -178].entries()) {
    const laneIndex = boostLanes[index];
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.75, .17, 10, 20), mat(0x20e6ff, .25, .35));
    ring.position.y = 1.15; ring.rotation.x = Math.PI / 2; ring.castShadow = true; group.add(ring);
    const glow = new THREE.PointLight(0x21dcff, 2, 5); glow.position.y = 1; group.add(glow);
    group.position.set(laneIndex * LANE_WIDTH, 0, z); group.userData = { lane: laneIndex, z, used: false };
    worldGroup.add(group); boosts.push(group);
  }
  makeGate(0); makeGate(-190);
}
function makeGate(z) {
  const group = new THREE.Group(); group.position.z = z;
  const white = mat(0xffffff), dark = mat(0x182237);
  box(group, -9, 2, 0, .6, 4, .6, white); box(group, 9, 2, 0, .6, 4, .6, white);
  box(group, 0, 4, 0, 18, .55, .6, dark);
  for (let i = -8; i < 9; i += 2) box(group, i, 4.01, .32, 1, .16, .08, i % 4 === 0 ? white : mat(0xffb52f));
  worldGroup.add(group);
}
function makeArrow(color) {
  const g = new THREE.Group(), m = mat(color);
  box(g, 0, 0, 0, .18, .12, 1.3, m);
  const a = box(g, 0, 0, -.55, .18, .12, .55, m); a.rotation.y = .5;
  const b = box(g, 0, 0, -.55, .18, .12, .55, m); b.rotation.y = -.5;
  return g;
}
function makeCar(modelId = "supra", color = "#ff3b5c", detailed = true) {
  const spec = VEHICLES[modelId] || VEHICLES.supra;
  const group = new THREE.Group();
  group.userData.modelId = modelId;
  const body = mat(color, .28, .48);
  const darkBody = mat(spec.roof, .3, .32);
  const glass = mat(0x152333, .15, .42);
  const tire = mat(0x10141b, .9, .02);
  const rim = mat(0xaebdcb, .25, .72);
  const dark = mat(0x090d13, .7, .18);
  const headlamp = mat(0xfff3c3, .18, .3);
  const tailLamp = mat(0xff263f, .22, .16);
  const width = spec.width, length = spec.length;
  const frontZ = -length / 2, backZ = length / 2;

  // Tapered shell: narrower bumpers and shoulders make the silhouette less box-like.
  const stations = [
    { z: -length * .50, lower: .64, upper: .48, top: .455 },
    { z: -length * .42, lower: .82, upper: .72, top: .555 },
    { z: -length * .25, lower: .96, upper: .87, top: .655 },
    { z:  length * .08, lower: 1.00, upper: .86, top: .665 },
    { z:  length * .32, lower: .95, upper: .82, top: .615 },
    { z:  length * .50, lower: .74, upper: .60, top: .525 }
  ];
  const shellPositions = [];
  const ringVertices = stations.map(station => {
    const lowerW = width * station.lower, upperW = width * station.upper;
    return [
      [-lowerW / 2, .285, station.z], [-upperW / 2, station.top, station.z],
      [upperW / 2, station.top, station.z], [lowerW / 2, .285, station.z]
    ];
  });
  const pushTri = (a, b, c) => shellPositions.push(...a, ...b, ...c);
  for (let r = 0; r < ringVertices.length - 1; r++) {
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      const a = ringVertices[r][edge], b = ringVertices[r][next];
      const c = ringVertices[r + 1][next], d = ringVertices[r + 1][edge];
      pushTri(a, c, b); pushTri(a, d, c);
    }
  }
  const frontRing = ringVertices[0], rearRing = ringVertices[ringVertices.length - 1];
  pushTri(frontRing[0], frontRing[1], frontRing[2]);
  pushTri(frontRing[0], frontRing[2], frontRing[3]);
  pushTri(rearRing[0], rearRing[2], rearRing[1]);
  pushTri(rearRing[0], rearRing[3], rearRing[2]);
  const shellGeometry = new THREE.BufferGeometry();
  shellGeometry.setAttribute("position", new THREE.Float32BufferAttribute(shellPositions, 3));
  shellGeometry.computeVertexNormals();
  const shell = new THREE.Mesh(shellGeometry, body);
  shell.castShadow = detailed; shell.receiveShadow = detailed; group.add(shell);
  // A lower hood and compact rear deck retain the recognizable proportions of each model.
  box(group, 0, .63, -length * .255, width * (spec.style === "wedge" ? .82 : .84), .12, spec.hood * .82, body);
  box(group, 0, .585, length * .34, width * .81, .105, .43, body);

  // Cabin / roof and dark glazing. Front faces -Z, in the same direction as the race.
  const cabin = box(group, 0, .88, spec.cabinZ, width * spec.cabinWidth, spec.cabinHeight, spec.cabinLength, darkBody);
  cabin.rotation.x = spec.style === "muscle" ? -.025 : .015;
  const windowWidth = width * spec.cabinWidth * .78;
  box(group, 0, 1.00, spec.cabinZ - spec.cabinLength * .34, windowWidth, spec.cabinHeight * .48, .045, glass).rotation.x = .52;
  box(group, 0, .99, spec.cabinZ + spec.cabinLength * .36, windowWidth, spec.cabinHeight * .45, .045, glass).rotation.x = -.48;
  for (const side of [-1, 1]) {
    box(group, side * width * .365, .90, spec.cabinZ, .035, spec.cabinHeight * .56, spec.cabinLength * .57, glass);
    const mirror = box(group, side * width * .54, .80, spec.cabinZ - spec.cabinLength * .14, .16, .08, .22, body);
    mirror.rotation.y = side * -.10;
  }

  // Four performance tyres with metallic rims and red brake calipers.
  const wheelX = width * .48;
  const wheelZ = length * .30;
  for (const x of [-wheelX, wheelX]) for (const z of [-wheelZ, wheelZ]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.285, .285, .19, detailed ? 18 : 10), tire);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, .29, z);
    wheel.castShadow = detailed;
    group.add(wheel);
    const alloy = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, .198, detailed ? 12 : 8), rim);
    alloy.rotation.z = Math.PI / 2;
    alloy.position.set(x + (x < 0 ? -.008 : .008), .29, z);
    group.add(alloy);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.065, .065, .205, 10), dark);
    hub.rotation.z = Math.PI / 2; hub.position.copy(alloy.position); group.add(hub);
    if (detailed) {
      const caliper = box(group, x + (x < 0 ? -.11 : .11), .32, z - .06, .07, .13, .12, mat(0xff392f));
      caliper.rotation.y = .2;
    }
  }

  // Model-specific front lighting and grille cues (not manufacturer logos).
  const lightXs = spec.lights === "round" ? [-.50, .50] : [-width * .34, width * .34];
  lightXs.forEach((x, idx) => {
    if (spec.lights === "round") {
      const halo = new THREE.Mesh(new THREE.SphereGeometry(.155, 12, 8), dark);
      halo.scale.set(1.16, .8, .28); halo.position.set(x, .62, frontZ - .035); group.add(halo);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.12, 12, 8), headlamp);
      lamp.scale.set(1.05, .62, .25); lamp.position.set(x, .625, frontZ - .06); group.add(lamp);
    } else {
      const lampWidth = spec.lights === "triple" ? .30 : (spec.lights === "slim" ? .38 : .32);
      const lamp = box(group, x, .62, frontZ - .045, lampWidth, .085, .055, headlamp);
      lamp.rotation.y = (x < 0 ? -1 : 1) * (spec.lights === "sweep" ? .18 : .04);
      if (spec.lights === "triple") {
        for (let part = 0; part < 3; part++) box(group, x + (idx ? -1 : 1) * (part - 1) * .085, .625, frontZ - .08, .035, .07, .025, dark);
      }
    }
  });
  if (spec.grille === "kidney") {
    for (const x of [-.19, .19]) box(group, x, .43, frontZ - .055, .23, .22, .055, dark);
  } else {
    const grilleWidth = spec.grille === "low" ? width * .46 : spec.grille === "angular" ? width * .70 : width * .64;
    const grilleHeight = spec.grille === "muscle" ? .22 : .17;
    box(group, 0, .415, frontZ - .045, grilleWidth, grilleHeight, .06, dark);
    if (spec.grille === "angular") {
      box(group, -.44, .42, frontZ - .07, .24, .13, .055, dark).rotation.z = -.20;
      box(group, .44, .42, frontZ - .07, .24, .13, .055, dark).rotation.z = .20;
    }
  }
  box(group, 0, .285, frontZ - .06, width * .88, .07, .18, dark); // splitter

  // Rear lamps, diffuser, and optional spoiler differentiate GT and muscle cars.
  for (const x of [-width * .34, width * .34]) {
    box(group, x, .59, backZ + .035, spec.style === "muscle" ? .25 : .29, .075, .055, tailLamp);
  }
  box(group, 0, .34, backZ + .04, width * .58, .12, .08, dark);
  if (spec.wing !== "none") {
    const wingY = spec.wing === "high" ? 1.05 : .76;
    const wingZ = backZ + (spec.wing === "high" ? -.13 : -.02);
    box(group, -.43, wingY - .08, backZ - .03, .06, spec.wing === "high" ? .38 : .11, .06, darkBody);
    box(group, .43, wingY - .08, backZ - .03, .06, spec.wing === "high" ? .38 : .11, .06, darkBody);
    box(group, 0, wingY, wingZ, width * .87, .08, .30, darkBody);
  }
  if (spec.style === "wedge" || spec.model === "huracan") {
    for (const x of [-1, 1]) box(group, x * width * .43, .51, .22, .07, .19, .52, dark);
  } else if (detailed) {
    for (const x of [-1, 1]) box(group, x * width * .49, .40, .02, .07, .12, length * .47, darkBody);
  }
  if (detailed) {
    // Small hood crease highlights make the paint read more like a finished car body.
    for (const x of [-1, 1]) box(group, x * width * .22, .713, -length * .27, .025, .012, spec.hood * .68, mat(0xffffff, .34, .18));
  }
  group.traverse(object => {
    if (object.isMesh) { object.castShadow = detailed; object.receiveShadow = detailed; }
  });
  return group;
}

function makeRemoteCar(modelId, color) {
  return makeCar(modelId || "supra", color || "#31b7ff", false);
}

function visualProgress() {
  const age = Math.min(.2, Math.max(0, (performance.now() - lastStateReceivedAt) / 1000));
  return Math.min(1, progress + speed * (boostTime > 0 ? 1.65 : 1) * age / 45);
}
function disposeRemoteCar(car) {
  scene?.remove(car);
  car.traverse(object => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material.dispose();
    }
  });
}
function updateRemoteCars(snapshot) {
  if (!scene) return;
  const nearest = [];
  const myProgress = visualProgress();
  for (const p of snapshot) {
    if (p.id === socket.id) continue;
    const z = 7 - ((p.progress || 0) - myProgress) * TRACK_LENGTH;
    if (z > -110 && z < 38) nearest.push({ player: p, z, distance: Math.abs(z - 7) });
  }
  // Keep at most 16 detailed-enough opponents in memory, not merely visible.
  nearest.sort((a, b) => a.distance - b.distance);
  const selected = nearest.slice(0, 16);
  const visible = new Set(selected.map(item => item.player.id));
  for (const [id, car] of cars) {
    if (!visible.has(id)) {
      disposeRemoteCar(car);
      cars.delete(id);
    }
  }
  for (const item of selected) {
    const p = item.player;
    let car = cars.get(p.id);
    if (!car) {
      car = makeRemoteCar(p.modelId || "supra", p.color || "#31b7ff");
      scene.add(car); cars.set(p.id, car);
    }
    car.position.set((p.lane ?? 0) * LANE_WIDTH, 0, item.z);
    car.visible = true;
  }
}
function sortPlayers(snapshot) {
  return [...snapshot].sort((a, b) => {
    if (a.finished && b.finished) return (a.finishTime || 0) - (b.finishTime || 0);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return (b.progress || 0) - (a.progress || 0);
  });
}
function updateLeaderboard(snapshot) {
  const sorted = sortPlayers(snapshot);
  const first = sorted.slice(0, 5);
  const me = sorted.find(p => p.id === socket.id);
  if (me && !first.some(p => p.id === me.id)) first.push(me);
  $("leaderboard").innerHTML = "<h3>🏆 ترتيب السباق</h3>" + first.map((p, i) =>
    `<div class="leader-row"><span class="rank">${sorted.findIndex(s => s.id === p.id) + 1}.</span><span class="lname"></span><span>${Math.floor((p.progress || 0) * 100)}%</span></div>`
  ).join("");
  $("leaderboard").querySelectorAll(".lname").forEach((el, i) => {
    const p = first[i]; el.textContent = p.name + (p.id === socket.id ? " (أنت)" : "");
  });
}
function showToast(text) {
  $("raceToast").textContent = text; show($("raceToast"));
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => hide($("raceToast")), 2600);
}
function keyIsDown(...names) {
  return names.some(name => !!keys[name]);
}
function readDrivingInput() {
  const pad = typeof navigator.getGamepads === "function"
    ? Array.from(navigator.getGamepads()).find(Boolean)
    : null;
  const left = keyIsDown("ArrowLeft", "KeyA", "a");
  const right = keyIsDown("ArrowRight", "KeyD", "d");
  const keySteer = (left ? -1 : 0) + (right ? 1 : 0);
  let steer = keySteer;
  if (pad && Math.abs(pad.axes?.[0] || 0) > .18) steer = THREE.MathUtils.clamp(pad.axes[0], -1, 1);
  const throttle = keyIsDown("ArrowUp", "KeyW", "w", "gas") || !!pad?.buttons?.[7]?.pressed || !!pad?.buttons?.[0]?.pressed;
  const brake = keyIsDown("ArrowDown", "KeyS", "s", "brake") || !!pad?.buttons?.[6]?.pressed;
  const handbrake = keyIsDown("ShiftLeft", "ShiftRight", "KeyX", "x", "drift") || !!pad?.buttons?.[2]?.pressed;
  const boost = keyIsDown("Space", "boost") || !!pad?.buttons?.[1]?.pressed;
  return { steer: THREE.MathUtils.clamp(steer, -1, 1), throttle, brake, handbrake, boost };
}
function updateControls(dt) {
  const now = Date.now();
  const dtSeconds = dt / 1000;
  const input = readDrivingInput();
  if (input.boost && !boostWasDown && now >= raceStartAt) socket.emit("player:boost");
  boostWasDown = input.boost;

  if (now < raceStartAt) {
    const remaining = Math.ceil((raceStartAt - now) / 1000);
    $("countdown").textContent = remaining > 0 ? remaining : "انطلق!";
    if (remaining <= 0 && !updateControls.countdownHidden) {
      updateControls.countdownHidden = true;
      setTimeout(() => hide($("countdown")), 500);
    }
    if (now - lastInputSent > 45) {
      socket.emit("player:input", { steer: 0, throttle: false, brake: false, handbrake: false });
      lastInputSent = now;
    }
    return;
  }
  updateControls.countdownHidden = false;

  // Smooth steering and speed-sensitive response: predictable at low speed, sharper at race speed.
  steerSmoothed = THREE.MathUtils.damp(steerSmoothed, input.steer, input.handbrake ? 13 : 9, dtSeconds);
  const steeringRate = (1.2 + speed * 1.6) * (input.handbrake ? 1.25 : 1);
  lane = THREE.MathUtils.clamp(lane + steerSmoothed * steeringRate * dtSeconds, LANE_MIN, LANE_MAX);
  const currentProgress = visualProgress();
  const currentZ = 7 - currentProgress * TRACK_LENGTH;

  for (const obstacle of obstacles) {
    if (obstacle.userData.hit) continue;
    if (Math.abs(obstacle.userData.z - currentZ) < 1.8 && Math.abs(lane - obstacle.userData.lane) < .48) {
      obstacle.userData.hit = true;
      showToast("💥 اقتربت من عائق! غيّر الممر لتفاديه.");
    }
  }
  for (const pickup of boosts) {
    if (pickup.userData.used) continue;
    if (Math.abs(pickup.userData.z - currentZ) < 2 && Math.abs(lane - pickup.userData.lane) < .55) {
      pickup.userData.used = true; pickup.visible = false;
      socket.emit("player:boost");
      showToast("⚡ حصلت على تعزيز سرعة!");
    }
  }
  if (playerCar) {
    playerCar.position.x = lane * LANE_WIDTH;
    playerCar.position.z = 7;
    playerCar.rotation.z = -steerSmoothed * (input.handbrake ? .11 : .055);
    playerCar.rotation.y = -steerSmoothed * (input.handbrake ? .12 : .065);
  }
  if (camera && playerCar) {
    camera.position.x += (playerCar.position.x * .5 - camera.position.x) * (1 - Math.exp(-4.5 * dtSeconds));
    camera.position.y = 6.5; camera.position.z = 15;
    camera.lookAt(playerCar.position.x * .4, 1, -8);
  }
  if (worldGroup) worldGroup.position.z = (currentProgress * TRACK_LENGTH) % 36;
  if (now - lastInputSent > 45) {
    socket.emit("player:input", {
      steer: steerSmoothed,
      throttle: input.throttle,
      brake: input.brake,
      handbrake: input.handbrake
    });
    lastInputSent = now;
  }
}
function animate() {
  if (!renderer || !racing) return;
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta() * 1000, 40);
  updateControls(dt);
  if (playerCar) playerCar.position.y = Math.sin(performance.now() * .008) * .012;
  renderer.render(scene, camera);
}
function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}
window.addEventListener("keydown", e => {
  if (isTypingTarget(e.target)) return;
  if (racing && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  keys[e.key] = true;
  keys[e.key.toLowerCase()] = true;
});
window.addEventListener("keyup", e => {
  keys[e.code] = false; keys[e.key] = false; keys[e.key.toLowerCase()] = false;
});
function releaseAllControls() {
  keys = {};
  steerSmoothed = 0;
}
window.addEventListener("blur", releaseAllControls);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAllControls(); });
function bindHold(id, key) {
  const el = $(id);
  if (!el) return;
  const down = e => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    keys[key] = true;
    el.classList.add("pressed");
  };
  const up = () => { keys[key] = false; el.classList.remove("pressed"); };
  el.addEventListener("pointerdown", down);
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => el.addEventListener(ev, up));
  el.addEventListener("contextmenu", e => e.preventDefault());
}
bindHold("leftBtn", "ArrowLeft"); bindHold("rightBtn", "ArrowRight");
bindHold("gasBtn", "gas"); bindHold("brakeBtn", "brake"); bindHold("driftBtn", "drift");
$("boostBtn").addEventListener("click", () => { socket.emit("player:boost"); });
