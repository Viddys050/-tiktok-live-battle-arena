import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const CONFIG_FILE = path.join(__dirname, "game-config.json");

const defaultConfig = {
  tiktokUsername: (process.env.TIKTOK_USERNAME || "").replace(/^@/, ""),
  demoMode: String(process.env.DEMO_MODE || "true").toLowerCase() !== "false",
  roundSeconds: 120,
  maxPlayers: 80,
  commentCooldownMs: 700,
  likeCooldownMs: 350,
  commands: {
    join: ["join", "meedoen"],
    attack: ["attack", "aanval", "hit", "fire", "vuur"],
    shield: ["shield", "schild", "defend", "verdedig"],
    rage: ["rage", "power", "boost"],
    boss: ["boss"]
  },
  gifts: {
    "rose": "attack",
    "finger heart": "shield",
    "perfume": "rage",
    "heart me": "rage",
    "galaxy": "boss"
  }
};

function loadConfig() {
  try {
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    return structuredClone(defaultConfig);
  }
}
let config = loadConfig();

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let tiktok = null;
let tiktokStatus = "offline";
let tiktokError = "";
let round = 1;
let roundStarted = Date.now();
let totalLikes = 0;
let totalGifts = 0;
let events = [];
let nextPlayerId = 1;
const players = new Map();
const cooldowns = new Map();
const giftStreaks = new Map();

function now() { return Date.now(); }
function cleanName(v) {
  return String(v || "Viewer").replace(/[<>]/g, "").slice(0, 22);
}
function normalize(v) {
  return String(v || "").trim().toLowerCase();
}
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}
function pushEvent(text, type="info") {
  const item = { id: `${Date.now()}-${Math.random()}`, text, type, ts: Date.now() };
  events.unshift(item);
  events = events.slice(0, 35);
  broadcast({ type: "feed", item });
}
function teamFor(id) {
  return id % 2 ? "red" : "blue";
}
function createPlayer(name, uniqueId="") {
  if (players.size >= Number(config.maxPlayers || 80)) {
    const existing = [...players.values()].sort((a,b) => a.lastSeen - b.lastSeen)[0];
    if (existing) players.delete(existing.id);
  }
  const id = nextPlayerId++;
  const player = {
    id, uniqueId: uniqueId || `viewer${id}`, name: cleanName(name),
    team: teamFor(id), level: 1, xp: 0, power: 100, hp: 100, maxHp: 100,
    score: 0, energy: 0, combo: 0, lastSeen: now(), alive: true,
    x: 10 + Math.random() * 80, y: 17 + Math.random() * 58
  };
  players.set(id, player);
  return player;
}
function getOrCreate(name, uniqueId="") {
  const key = normalize(uniqueId || name);
  for (const p of players.values()) if (normalize(p.uniqueId) === key) {
    p.name = cleanName(name || p.name);
    p.lastSeen = now();
    return p;
  }
  return createPlayer(name, uniqueId);
}
function addXp(p, amount) {
  p.xp += amount;
  const need = 100 + (p.level - 1) * 70;
  while (p.xp >= need) {
    p.xp -= need;
    p.level++;
    p.maxHp += 10;
    p.hp = Math.min(p.maxHp, p.hp + 25);
    p.power += 8;
    pushEvent(`⬆️ ${p.name} is nu level ${p.level}!`, "level");
  }
}
function canDo(key, uniqueId, ms) {
  const k = `${key}:${uniqueId}`;
  const t = cooldowns.get(k) || 0;
  if (now() - t < ms) return false;
  cooldowns.set(k, now());
  return true;
}
function enemyOf(p) {
  const enemies = [...players.values()].filter(x => x.team !== p.team && x.alive);
  if (!enemies.length) return null;
  return enemies.sort((a,b) => a.hp - b.hp || b.score - a.score)[0];
}
function attack(p, strength=1, source="comment") {
  if (!p.alive) return;
  const target = enemyOf(p);
  p.energy = Math.min(100, p.energy + 8 * strength);
  p.score += 10 * strength;
  addXp(p, 18 * strength);
  if (!target) {
    pushEvent(`⚔️ ${p.name} laadt een aanval!`, "attack");
    return;
  }
  const damage = Math.max(4, Math.round((18 + p.power * 0.12) * strength));
  target.hp -= damage;
  p.combo = Math.min(99, p.combo + 1);
  target.combo = 0;
  pushEvent(`💥 ${p.name} doet ${damage} schade aan ${target.name}!`, "attack");
  broadcast({ type:"action", action:"attack", from:p.id, to:target.id, strength, source });
  if (target.hp <= 0) {
    target.hp = 0; target.alive = false;
    p.score += 250;
    addXp(p, 60);
    pushEvent(`☠️ ${target.name} is uitgeschakeld door ${p.name}!`, "ko");
    setTimeout(() => {
      if (players.has(target.id)) {
        target.hp = target.maxHp; target.alive = true; target.energy = 0;
        target.x = 10 + Math.random() * 80; target.y = 17 + Math.random() * 58;
      }
    }, 5000);
  }
}
function shield(p) {
  p.energy = Math.min(100, p.energy + 20);
  p.hp = Math.min(p.maxHp, p.hp + 18);
  p.score += 12;
  addXp(p, 15);
  broadcast({ type:"action", action:"shield", player:p.id });
  pushEvent(`🛡️ ${p.name} activeert SHIELD!`, "shield");
}
function rage(p) {
  p.energy = Math.min(100, p.energy + 50);
  p.power += 4;
  p.score += 40;
  addXp(p, 25);
  broadcast({ type:"action", action:"rage", player:p.id });
  pushEvent(`⚡ ${p.name} activeert RAGE!`, "rage");
}
function boss(p) {
  if (p.energy < 70) {
    pushEvent(`🔒 ${p.name} heeft 70 energie nodig voor BOSS.`, "warn");
    return;
  }
  p.energy -= 70;
  const enemies = [...players.values()].filter(x => x.team !== p.team && x.alive);
  for (const target of enemies) target.hp = Math.max(1, target.hp - 22);
  p.score += 300;
  addXp(p, 80);
  broadcast({ type:"action", action:"boss", player:p.id });
  pushEvent(`👹 BOSS ATTACK door ${p.name}! ${enemies.length} tegenstanders geraakt!`, "boss");
}
function command(p, cmd) {
  const c = normalize(cmd);
  if (config.commands.join.map(normalize).includes(c)) {
    p.score += 25; addXp(p, 20); p.energy = Math.min(100, p.energy + 10);
    pushEvent(`🟢 ${p.name} doet mee aan de arena!`, "join");
  } else if (config.commands.attack.map(normalize).includes(c)) attack(p, 1, "comment");
  else if (config.commands.shield.map(normalize).includes(c)) shield(p);
  else if (config.commands.rage.map(normalize).includes(c)) rage(p);
  else if (config.commands.boss.map(normalize).includes(c)) boss(p);
  else {
    p.score += 2; addXp(p, 3);
  }
}
function handleChat(data) {
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const comment = String(data.comment || "").trim();
  const p = getOrCreate(name, uid);
  if (!canDo("chat", uid, Number(config.commentCooldownMs || 700))) return;
  pushEvent(`💬 ${cleanName(name)}: ${comment}`, "chat");
  const first = normalize(comment).split(/\s+/)[0];
  command(p, first);
}
function handleLike(data) {
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const count = Math.max(1, Number(data.likeCount || data.likeCount || 1));
  if (!canDo("like", uid, Number(config.likeCooldownMs || 350))) return;
  const p = getOrCreate(name, uid);
  p.energy = Math.min(100, p.energy + Math.min(25, count));
  p.score += Math.min(100, count * 2);
  addXp(p, Math.min(20, count));
  totalLikes += count;
  broadcast({ type:"action", action:"like", player:p.id, count });
  pushEvent(`❤️ ${p.name} geeft ${count} like${count===1?"":"s"}!`, "like");
}
function handleGift(data) {
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const giftName = String(data.giftDetails?.giftName || data.giftName || data.extendedGiftInfo?.name || "Gift");
  const count = Math.max(1, Number(data.repeatCount || 1));
  const diamond = Number(data.giftDetails?.diamondCount || data.diamondCount || data.extendedGiftInfo?.diamondCount || 0);
  const p = getOrCreate(name, uid);
  const key = `${uid}:${normalize(giftName)}`;
  giftStreaks.set(key, { count, last: now() });
  totalGifts += count;

  const mapped = Object.entries(config.gifts).find(([needle]) => normalize(giftName).includes(normalize(needle)))?.[1];
  const strength = Math.min(10, count);
  if (mapped === "shield") for (let i=0;i<Math.min(3,strength);i++) shield(p);
  else if (mapped === "rage") rage(p);
  else if (mapped === "boss") boss(p);
  else attack(p, Math.max(1, Math.ceil(strength/2)), "gift");

  p.score += Math.max(10, diamond * 2);
  addXp(p, Math.max(5, Math.min(80, diamond)));
  pushEvent(`🎁 ${p.name} → ${giftName} ×${count}`, "gift");
}
function handleMember(data) {
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const p = getOrCreate(name, uid);
  p.score += 5;
  p.lastSeen = now();
}

function serialize() {
  const list = [...players.values()]
    .sort((a,b) => b.score - a.score)
    .map(p => ({...p}));
  return {
    type: "state",
    round, roundSeconds: Number(config.roundSeconds || 120),
    remaining: Math.max(0, Number(config.roundSeconds || 120) - Math.floor((now()-roundStarted)/1000)),
    totalLikes, totalGifts, tiktokStatus, tiktokError,
    players: list, feed: events.slice(0, 20),
    config: {
      commands: config.commands,
      gifts: config.gifts
    }
  };
}
function broadcastState() { broadcast(serialize()); }

async function getTikTokRoomId(username) {
  console.log("Trying direct TikTok LIVE page room lookup...");
  try {
    const liveUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
    const pageResponse = await fetch(liveUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const html = await pageResponse.text();
    console.log("TikTok LIVE page HTTP:", pageResponse.status, "bytes:", html.length);

    const directPatterns = [
      /snssdk\\d*:\\/\\/live\\?room_id=(\\d+)/i,
      /"roomId"\\s*:\\s*"?(\\d{10,})"?/i,
      /"room_id"\\s*:\\s*"?(\\d{10,})"?/i
    ];
    for (const pattern of directPatterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        console.log("Found LIVE room ID in page:", match[1]);
        return String(match[1]);
      }
    }

    const scriptPatterns = [
      /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\\s\\S]*?)<\\/script>/i,
      /<script[^>]+id="sigi-persisted-data"[^>]*>([\\s\\S]*?)<\\/script>/i,
      /<script[^>]+id="SIGI_STATE"[^>]*>([\\s\\S]*?)<\\/script>/i
    ];
    for (const pattern of scriptPatterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      try {
        const data = JSON.parse(match[1]);
        const json = JSON.stringify(data);
        const roomMatch = json.match(/"roomId":"?(\\d{10,})"?/i);
        if (roomMatch?.[1]) {
          console.log("Found LIVE room ID in embedded JSON:", roomMatch[1]);
          return String(roomMatch[1]);
        }
      } catch {}
    }

    console.log("TikTok LIVE page did not expose a room ID.");
  } catch (err) {
    console.log("Direct LIVE page lookup failed:", err?.message || err);
  }

  console.log("Trying TikRec signed TikTok room lookup...");
  let signError = null;

  try {
    const signUrl = `https://tikrec.com/tiktok/room/api/sign?unique_id=${encodeURIComponent(username)}`;
    const signResponse = await fetch(signUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const signText = await signResponse.text();
    console.log("TikRec signer HTTP:", signResponse.status, "bytes:", signText.length);

    if (!signResponse.ok) throw new Error(`HTTP ${signResponse.status}`);

    const signed = JSON.parse(signText);
    const signedUrl = signed?.signed_url ||
      (signed?.signed_path ? `https://www.tiktok.com${signed.signed_path}` : "");

    if (!signedUrl) throw new Error("TikRec returned no signed URL");

    const roomResponse = await fetch(signedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://www.tiktok.com/",
        "Origin": "https://www.tiktok.com",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    const roomText = await roomResponse.text();
    console.log("Signed TikTok room HTTP:", roomResponse.status, "bytes:", roomText.length);

    const data = JSON.parse(roomText);
    const roomId =
      data?.data?.room_info?.id ||
      data?.data?.roomInfo?.roomId ||
      data?.data?.room_info?.roomId ||
      data?.data?.user?.roomId ||
      data?.data?.liveRoom?.roomId ||
      data?.room_id;

    if (!roomId) {
      throw new Error(`Signed API returned no room ID (status ${data?.statusCode ?? data?.status_code ?? "unknown"})`);
    }

    return String(roomId);
  } catch (err) {
    signError = err;
    console.log("TikRec lookup failed:", err?.message || err);
  }

  console.log("Trying direct TikTok API room lookup as fallback...");

  const params = new URLSearchParams({
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Safari",
    browser_online: "true",
    browser_platform: "iPhone",
    browser_version: "18.6",
    device_platform: "web",
    from_page: "user",
    is_page_visible: "true",
    channel: "tiktok_web",
    region: "US",
    webcast_language: "en",
    sourceType: "54",
    uniqueId: username
  });

  const url = `https://www.tiktok.com/api-live/user/room/?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      "Accept": "application/json,text/plain,*/*",
      "Referer": "https://www.tiktok.com/",
      "Origin": "https://www.tiktok.com",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`TikTok API returned non-JSON HTTP ${response.status}`); }

  if (!response.ok || data?.statusCode) {
    throw new Error(`TikTok API error HTTP ${response.status}: ${data?.statusCode || ""} ${data?.message || ""}${signError ? `; signed lookup also failed: ${signError.message}` : ""}`);
  }

  const roomId = data?.data?.user?.roomId || data?.data?.liveRoom?.roomId;
  if (!roomId) throw new Error("TikTok API returned no LIVE room ID");
  return String(roomId);
}

async function connectTikTok() {
  console.log("=== TIKTOK CONNECTION START ===");
  console.log("Username:", config.tiktokUsername);

  if (tiktok) {
    try {
      await tiktok.disconnect();
    } catch {}
    tiktok = null;
  }

  const username = String(config.tiktokUsername || "").replace(/^@/, "").trim();

  if (!username) {
    console.log("NO TIKTOK USERNAME");
    tiktokStatus = "demo";
    tiktokError = "";
    broadcastState();
    return;
  }

  try {
    tiktokStatus = "connecting";
    tiktokError = "";
    broadcastState();

    tiktok = new TikTokLiveConnection(username, {
      processInitialData: false,
      connectWithUniqueId: true,
      logFetchFallbackErrors: true,
      disableEulerFallbacks: false
    });

    console.log("Finding TikTok LIVE room ID with direct page parser...");
    const roomId = await getTikTokRoomId(username);
    console.log("Found LIVE room ID:", roomId);

    tiktok.on(WebcastEvent.CHAT, handleChat);
    tiktok.on(WebcastEvent.LIKE, handleLike);
    tiktok.on(WebcastEvent.GIFT, handleGift);
    tiktok.on(WebcastEvent.MEMBER, handleMember);

    tiktok.on("connected", (state) => {
      console.log("=== TIKTOK CONNECTED ===");
      console.log("Room ID:", state?.roomId || "unknown");
      tiktokStatus = "connected";
      tiktokError = "";
      pushEvent(`🟢 Connected to @${username}`, "system");
      broadcastState();
    });

    tiktok.on("disconnected", (info) => {
      console.log("=== TIKTOK DISCONNECTED ===");
      console.log(info || "");
      tiktokStatus = "offline";
      broadcastState();
    });

    tiktok.on("error", (err) => {
      console.error("=== TIKTOK ERROR ===");
      console.error(err);
      tiktokStatus = "error";
      tiktokError = String(err?.message || err);
      pushEvent(`🔴 TikTok error: ${tiktokError}`, "error");
      broadcastState();
    });

    console.log("Calling tiktok.connect(roomId)...");
    const result = await tiktok.connect(roomId);

    console.log("=== TIKTOK CONNECT() RESOLVED ===");
    console.log(result);

  } catch (err) {
    console.error("=== TIKTOK CONNECT FAILED ===");
    console.error(err);

    tiktokStatus = "error";
    tiktokError = String(err?.message || err);

    pushEvent(`🔴 TikTok connection failed: ${tiktokError}`, "error");
    broadcastState();
  }
}
function resetRound() {
  round++;
  roundStarted = now();
  for (const p of players.values()) {
    p.hp = p.maxHp; p.alive = true; p.energy = 0; p.combo = 0;
    p.x = 10 + Math.random() * 80; p.y = 17 + Math.random() * 58;
  }
  pushEvent(`🏁 Ronde ${round} begint!`, "round");
  broadcastState();
}

app.get("/api/state", (_,res) => res.json(serialize()));
app.get("/api/config", (_,res) => res.json(config));
app.post("/api/config", async (req,res) => {
  const incoming = req.body || {};
  if (typeof incoming.tiktokUsername === "string")
    config.tiktokUsername = incoming.tiktokUsername.replace(/^@/,"").trim();
  if (typeof incoming.demoMode === "boolean") config.demoMode = incoming.demoMode;
  if (Number.isFinite(Number(incoming.roundSeconds)))
    config.roundSeconds = Math.max(30, Math.min(600, Number(incoming.roundSeconds)));
  if (incoming.commands && typeof incoming.commands === "object") config.commands = incoming.commands;
  if (incoming.gifts && typeof incoming.gifts === "object") config.gifts = incoming.gifts;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  await connectTikTok();
  res.json({ok:true, config, status:tiktokStatus});
});
app.post("/api/reset", (_,res) => { players.clear(); round=1; roundStarted=now(); events=[]; totalLikes=0; totalGifts=0; nextPlayerId=1; pushEvent("🔄 Spel gereset.", "system"); res.json({ok:true}); });
app.post("/api/demo", (req,res) => {
  const actions = ["join","attack","shield","rage","boss","like","gift"];
  const action = req.body?.action || actions[Math.floor(Math.random()*actions.length)];
  const names = ["Luna","Rico","Mila","Daan","Noah","Jay","Sanne","Max","Kai","Nova"];
  const name = req.body?.name || names[Math.floor(Math.random()*names.length)];
  const p = getOrCreate(name, `demo-${name}`);
  if (action === "attack") attack(p,2,"demo");
  else if (action === "shield") shield(p);
  else if (action === "rage") rage(p);
  else if (action === "boss") { p.energy=100; boss(p); }
  else if (action === "like") handleLike({ uniqueId:`demo-${name}`, nickname:name, likeCount:10 });
  else if (action === "gift") handleGift({ uniqueId:`demo-${name}`, nickname:name, giftName:"Rose", repeatCount:5, diamondCount:1 });
  else command(p, action === "join" ? "join" : "hello");
  res.json({ok:true});
});
app.get("/api/health", (_,res)=>res.json({ok:true,status:tiktokStatus,players:players.size}));

wss.on("connection", ws => {
  ws.send(JSON.stringify(serialize()));
  ws.on("message", raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "ping") ws.send(JSON.stringify({type:"pong"}));
    } catch {}
  });
});

setInterval(() => {
  if (now() - roundStarted >= Number(config.roundSeconds || 120)*1000) resetRound();
  broadcastState();
}, 1000);

server.listen(PORT, async () => {
  console.log(`Battle Arena v2 running on http://localhost:${PORT}`);
  await connectTikTok();
});
