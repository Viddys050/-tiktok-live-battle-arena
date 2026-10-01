import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";

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
    boss: ["boss"],
    boys: ["boys","boy","jongens","mannen"],
    girls: ["girls","girl","meiden","vrouwen"]
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
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      ...defaultConfig,
      ...saved,
      commands: { ...defaultConfig.commands, ...(saved.commands || {}) },
      gifts: { ...defaultConfig.gifts, ...(saved.gifts || {}) }
    };
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
let lastRoomId = "";
let tiktokStatus = "offline";
let tiktokError = "";
let reconnectTimer = null;
let reconnectKickTimer = null;
let livePreviewBrowser = null;
let livePreviewPage = null;
let livePreviewBusy = false;
let livePreviewInitPromise = null;
let reconnectInProgress = false;
let round = 1;
let roundStarted = Date.now();
let gameActive = false;
let totalLikes = 0;
let totalGifts = 0;
let musicOn = false;
const giftStats = new Map();
let events = [];
let nextPlayerId = 1;
const players = new Map();
const cooldowns = new Map();
const giftStreaks = new Map();

function getRoundRemaining() {
  return Math.max(0, Number(config.roundSeconds || 120) - Math.floor((now() - roundStarted) / 1000));
}
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
    team: null, level: 1, xp: 0, power: 100, hp: 100, maxHp: 100,
    score: 0, energy: 0, combo: 0, likesGiven: 0, giftsGiven: 0, lastSeen: now(), alive: true,
    x: 10 + Math.random() * 80, y: 17 + Math.random() * 58,
    vx: (Math.random() * 2 - 1) * 0.22, vy: (Math.random() * 2 - 1) * 0.16,
    angle: Math.random() * 360, spin: (Math.random() * 2 - 1) * 1.8, lastCollision: 0
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
  if (tiktokStatus !== "connected" || !p.alive || !p.team) return;
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
  broadcast({ type:"action", action:"attack", from:p.id, to:target.id, strength, source, damage });
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
  if (tiktokStatus !== "connected" || !p.team) return;
  p.energy = Math.min(100, p.energy + 20);
  p.hp = Math.min(p.maxHp, p.hp + 18);
  p.score += 12;
  addXp(p, 15);
  broadcast({ type:"action", action:"shield", player:p.id, name:p.name });
  pushEvent(`🛡️ ${p.name} activeert SHIELD!`, "shield");
}
function rage(p) {
  if (tiktokStatus !== "connected" || !p.team) return;
  p.energy = Math.min(100, p.energy + 50);
  p.power += 4;
  p.score += 40;
  addXp(p, 25);
  broadcast({ type:"action", action:"rage", player:p.id, name:p.name });
  pushEvent(`⚡ ${p.name} activeert RAGE!`, "rage");
}
function boss(p) {
  if (tiktokStatus !== "connected" || !p.team) return;
  if (p.energy < 70) {
    pushEvent(`🔒 ${p.name} heeft 70 energie nodig voor BOSS.`, "warn");
    return;
  }
  p.energy -= 70;
  const enemies = [...players.values()].filter(x => x.team !== p.team && x.alive);
  for (const target of enemies) target.hp = Math.max(1, target.hp - 22);
  p.score += 300;
  addXp(p, 80);
  broadcast({ type:"action", action:"boss", player:p.id, name:p.name });
  pushEvent(`👹 BOSS ATTACK door ${p.name}! ${enemies.length} tegenstanders geraakt!`, "boss");
}
function command(p, cmd) {
  const c = normalize(cmd);
  const teamCommand = config.commands.boys?.map(normalize).includes(c) || config.commands.girls?.map(normalize).includes(c);
  // Team selection is the core BOYS vs GIRLS mechanic. It must never be blocked
  // by the old combat/gameActive checks and it never gives or removes points.
  if (teamCommand) {
    if (config.commands.boys?.map(normalize).includes(c)) {
      p.team = "red";
      pushEvent(`🔵 ${p.name} joins BOYS!`, "join");
      broadcast({ type:"action", action:"team", player:p.id, team:"red", name:p.name });
    } else if (config.commands.girls?.map(normalize).includes(c)) {
      p.team = "blue";
      pushEvent(`🩷 ${p.name} joins GIRLS!`, "join");
      broadcast({ type:"action", action:"team", player:p.id, team:"blue", name:p.name });
    }
    broadcastState();
    return;
  }
  if (tiktokStatus !== "connected" || !gameActive) return;
  if (!p.team && !teamCommand) {
    pushEvent(`⚠️ ${p.name} must choose BOYS or GIRLS first.`, "warn");
    return;
  }
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
function rawTikTokEvent(event, data) { try { broadcast({ type:"rawEvent", event, data }); } catch {} }
function bindTikTokEvent(name, eventName) { try { tiktok.on(name, data => rawTikTokEvent(eventName, data)); } catch {} }
function handleChat(data) {
  rawTikTokEvent("CHAT", data);
  if (tiktokStatus !== "connected" || !gameActive) return;

  const user = data?.user || {};
  const name = user.nickname || data?.nickname || data?.uniqueId || "Viewer";
  const uid = user.uniqueId || data?.uniqueId || name;
  const comment = String(
    data?.comment ??
    data?.text ??
    data?.message?.comment ??
    ""
  ).trim();

  if (!comment) return;

  const p = getOrCreate(name, uid);
  const first = normalize(comment).split(/\s+/)[0];

  // Team selection is never blocked by the normal chat cooldown.
  // BOYS / GIRLS must work immediately when the LIVE is connected.
  const isTeamCommand =
    config.commands.boys?.map(normalize).includes(first) ||
    config.commands.girls?.map(normalize).includes(first);

  if (isTeamCommand) {
    command(p, first);
    pushEvent(`🎯 ${cleanName(name)} selected ${first.toUpperCase()}`, "system");
    broadcastState();
    return;
  }

  if (!canDo("chat", uid, Number(config.commentCooldownMs || 700))) return;

  pushEvent(`💬 ${cleanName(name)}: ${comment}`, "chat");
  command(p, first);
}
function handleLike(data) {
  rawTikTokEvent("LIKE", data);
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const count = Math.max(1, Number(data.likeCount || data.likeCount || 1));
  if (!canDo("like", uid, Number(config.likeCooldownMs || 350))) return;
  const p = getOrCreate(name, uid);
  if (tiktokStatus !== "connected" || !p.team) return;
  const finalBattle = getRoundRemaining() <= 10;
  const power = finalBattle ? 3 : 1;
  p.energy = Math.min(100, p.energy + Math.min(25, count) * power);
  p.score += Math.min(100, count * 2) * power;
  addXp(p, Math.min(20, count) * power);
  totalLikes += count;
  p.likesGiven += count;
  broadcast({ type:"action", action:"like", player:p.id, team:p.team, count: count * power, likeCount: count, name:p.name, finalBattle });
  pushEvent(`❤️ ${p.name} geeft ${count} like${count===1?"":"s"}!${finalBattle?" 🔥 FINAL BATTLE x3!":""}`, "like");
}
function handleGift(data) {
  rawTikTokEvent("GIFT", data);
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const giftName = String(data.giftDetails?.giftName || data.giftName || data.extendedGiftInfo?.name || "Gift");
  const count = Math.max(1, Number(data.repeatCount || 1));
  const diamond = Number(data.giftDetails?.diamondCount || data.diamondCount || data.extendedGiftInfo?.diamondCount || 0);
  const p = getOrCreate(name, uid);
  if (tiktokStatus !== "connected" || !p.team) return;

  // TikTok can emit multiple events while a streakable Gift is in progress.
  // Record the event, but only trigger one visual reaction for the final streak event.
  const giftType = Number(data.giftDetails?.giftType || data.giftType || 0);
  const repeatEnd = data.repeatEnd === true;
  const isStreakProgress = giftType === 1 && !repeatEnd;
  totalGifts += count;
  p.giftsGiven += count;
  const giftKey = normalize(giftName);
  const previousGift = giftStats.get(giftKey) || { name: giftName, count: 0, diamonds: 0 };
  previousGift.name = giftName;
  previousGift.count += count;
  previousGift.diamonds += diamond * count;
  giftStats.set(giftKey, previousGift);

  // Gifts are a visual LIVE interaction only. They never change gameplay, score, power,
  // health, energy, team strength, or the winner.
  pushEvent(`🎁 ${p.name} sent ${giftName} ×${count}`, "gift");
  if (!isStreakProgress) {
    broadcast({
      type:"action",
      action:"giftReceived",
      player:p.id,
      team:p.team,
      name:p.name,
      giftName,
      count
    });
  }
}
function handleMember(data) {
  rawTikTokEvent("MEMBER", data);
  const name = data.user?.nickname || data.nickname || data.uniqueId || "Viewer";
  const uid = data.user?.uniqueId || data.uniqueId || name;
  const p = getOrCreate(name, uid);
  if (tiktokStatus !== "connected" || !p.team) return;
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
    totalLikes, totalGifts, musicOn, tiktokStatus, tiktokError, gameActive,
    players: list, feed: events.slice(0, 20),
    giftStats: [...giftStats.values()].sort((a,b) => b.count - a.count),
    metrics: { uptime: Math.floor((now() - roundStarted) / 1000), connections: wss.clients.size },
    roomId: lastRoomId,
    config: {
      tiktokUsername: config.tiktokUsername,
      demoMode: config.demoMode,
      roundSeconds: config.roundSeconds,
      maxPlayers: config.maxPlayers,
      commentCooldownMs: config.commentCooldownMs,
      likeCooldownMs: config.likeCooldownMs,
      commands: config.commands,
      gifts: config.gifts
    }
  };
}
function broadcastState() { broadcast(serialize()); }

async function getTikTokRoomIdWithBrowser(username) {
  // Reuse the same Chromium instance as the LIVE preview.
  // Render can reject a second Chromium executable with ETXTBSY, so we must
  // not launch a separate browser just to discover the room id.
  try {
    console.log("Trying shared Chromium LIVE room discovery...");
    const browser = await getLivePreviewBrowser();
    if (!browser?.isConnected()) throw new Error("Shared Chromium browser is not connected");
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1
    });
    if (!page || page.isClosed()) throw new Error("Shared Chromium created no usable page");
    const candidates = new Set();

    const inspect = (value) => {
      if (!value) return;
      const text = String(value);
      const patterns = [
        /"roomId"\s*[:=]\s*"?(\d{10,})"?/gi,
        /"room_id"\s*[:=]\s*"?(\d{10,})"?/gi,
        /roomId\D{0,80}(\d{10,})/gi,
        /room_id\D{0,80}(\d{10,})/gi,
        /roomID\D{0,80}(\d{10,})/gi,
        /room_id=(\d{10,})/gi,
        /roomId=(\d{10,})/gi,
        /webcast_id[=:](\d{10,})/gi
      ];
      for (const re of patterns) {
        for (const m of text.matchAll(re)) candidates.add(m[1]);
      }
    };

    const onResponse = async (response) => {
      try {
        const url = response.url();
        if (!/tiktok\.com/i.test(url)) return;
        inspect(url);
        if (!/live|room|webcast|api-live/i.test(url)) return;
        const body = await response.text();
        inspect(body);
      } catch {}
    };

    page.on("response", onResponse);

    const liveUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
    if (!page.url().includes(`/@${encodeURIComponent(username)}/live`)) {
      await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    }

    await page.waitForTimeout(7000);

    inspect(page.url());
    inspect(await page.content());

    const scriptData = await page.evaluate(() => {
      const ids = ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "sigi-persisted-data", "SIGI_STATE"];
      const out = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el?.textContent) out.push(el.textContent);
      }
      return out;
    });
    for (const item of scriptData) inspect(item);

    page.off("response", onResponse);
    await page.close().catch(() => {});

    if (candidates.size) {
      const roomId = [...candidates][0];
      console.log("Found LIVE room ID with shared Chromium:", roomId);
      return roomId;
    }

    console.log("Shared Chromium did not expose a LIVE room ID.");
  } catch (err) {
    console.log("Shared Chromium room lookup failed:", err?.message || err);
  }
  return null;
}

async function getTikTokRoomId(username) {
  // Fast path first: HTTP lookups are much cheaper than starting Chromium.
  // Chromium is kept as the final fallback because it can take 10+ seconds on Render.
  console.log("=== ROOM ID LOOKUP START ===");
  console.log("Account:", "@"+username);
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
      /snssdk\d*:\/\/live\?room_id=(\d+)/i,
      /"roomId"\s*:\s*"?(\d{10,})"?/i,
      /"room_id"\s*:\s*"?(\d{10,})"?/i
    ];
    for (const pattern of directPatterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        console.log("Found LIVE room ID in page:", match[1]);
        return String(match[1]);
      }
    }

    const scriptPatterns = [
      /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
      /<script[^>]+id="sigi-persisted-data"[^>]*>([\s\S]*?)<\/script>/i,
      /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
    ];
    for (const pattern of scriptPatterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      try {
        const data = JSON.parse(match[1]);
        const json = JSON.stringify(data);
        const roomMatch = json.match(/"roomId":"?(\d{10,})"?/i);
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

  try {
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`TikTok API returned non-JSON HTTP ${response.status}`); }

    if (!response.ok || data?.statusCode) {
      throw new Error(`TikTok API error HTTP ${response.status}: ${data?.statusCode || ""} ${data?.message || ""}`);
    }

    const roomId = data?.data?.user?.roomId || data?.data?.liveRoom?.roomId;
    if (roomId) return String(roomId);
    throw new Error("TikTok API returned no LIVE room ID");
  } catch (apiError) {
    console.log("Direct TikTok API lookup failed:", apiError?.message || apiError);
  }

  // Last resort: Chromium. This is intentionally last because it is the slowest
  // method and is only needed when TikTok hides the room ID from HTTP responses.
  const browserRoomId = await getTikTokRoomIdWithBrowser(username);
  if (browserRoomId) return String(browserRoomId);

  throw new Error(`TikTok LIVE room lookup failed. Direct page, TikRec, API and browser lookup all failed.${signError ? ` TikRec: ${signError.message}` : ""}`);
}

async function connectTikTok() {
  if (reconnectInProgress) return;
  reconnectInProgress = true;
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

    // Use the connector's normal username -> LIVE resolution.
    // This avoids forcing the external uniqueId resolver on every connection.
    tiktok = new TikTokLiveConnection(username, {
      processInitialData: false,
      // TikTok can report a freshly discovered LIVE room as "offline" during
      // the connector's extra room-info check. We already discovered the room
      // directly from the LIVE page, so do not perform that second live check.
      fetchRoomInfoOnConnect: false,
      logFetchFallbackErrors: true,
      // Keep connection attempts short. The connector's WebSocket handshake can
      // otherwise wait around 20 seconds before surfacing a failure.
      webClientOptions: { timeout: { request: 7000 } },
      wsClientOptions: { handshakeTimeout: 7000 }
    });

    tiktok.on(WebcastEvent.CHAT, handleChat);
    tiktok.on(WebcastEvent.LIKE, handleLike);
    tiktok.on(WebcastEvent.GIFT, handleGift);
    tiktok.on(WebcastEvent.MEMBER, handleMember);
    bindTikTokEvent("social","SOCIAL");
    bindTikTokEvent("follow","FOLLOW");
    bindTikTokEvent("share","SHARE");
    bindTikTokEvent("roomUser","ROOM_USER");
    bindTikTokEvent("emote","EMOTE");
    bindTikTokEvent("questionNew","QUESTION_NEW");
    bindTikTokEvent("linkMicBattle","LINK_MIC_BATTLE");
    bindTikTokEvent("linkMicArmies","LINK_MIC_ARMIES");
    bindTikTokEvent("liveIntro","LIVE_INTRO");
    bindTikTokEvent("subscribe","SUBSCRIBE");
    bindTikTokEvent("envelope","ENVELOPE");

    tiktok.on("connected", (state) => {
      console.log("=== TIKTOK CONNECTED ===");
      console.log("Room ID:", state?.roomId || "unknown");
      tiktokStatus = "connected";
      tiktokError = "";
      gameActive = true;
      round++;
      roundStarted = Date.now();
      players.clear();
      totalLikes = 0;
      totalGifts = 0;
      giftStats.clear();
      events = [];
      pushEvent(`🟢 Connected to @${username} — game is LIVE!`, "system");
      broadcastState();
    });

    tiktok.on("streamEnd", (info) => {
      console.log("=== TIKTOK STREAM END ===");
      console.log(info || "");
      tiktokStatus = "offline";
      gameActive = false;
      broadcastState();
    });

    tiktok.on("websocketConnected", () => {
      console.log("=== TIKTOK WEBSOCKET CONNECTED ===");
    });

    tiktok.on("disconnected", (info) => {
      console.log("=== TIKTOK DISCONNECTED ===");
      console.log(info || "");
      tiktokStatus = "offline";
      gameActive = false;
      broadcastState();

      // The disconnect event can fire while connectTikTok() is still unwinding.
      // Do not rely on reconnectInProgress here; always schedule a fresh attempt.
      clearTimeout(reconnectKickTimer);
      reconnectKickTimer = setTimeout(() => {
        reconnectKickTimer = null;
        if (tiktokStatus !== "connected" && !reconnectInProgress) connectTikTok();
      }, 2000);
    });

    tiktok.on("error", (err) => {
      console.error("=== TIKTOK ERROR ===");
      console.error(err);
      tiktokStatus = "error";
      gameActive = false;
      tiktokError = String(err?.message || err);
      pushEvent(`🔴 TikTok error: ${tiktokError}`, "error");
      broadcastState();
    });

    // Resolve the LIVE room once, then pass the explicit roomId to the connector.
    // This avoids making tiktok-live-connector repeat its own room lookup.
    // It also lets the control room show the exact room we are trying to enter.
    const roomId = await getTikTokRoomId(username);
    if (!roomId) throw new Error("TikTok is not LIVE or no room ID could be resolved.");
    lastRoomId = String(roomId);
    broadcastState();
    console.log("Calling tiktok.connect(roomId):", roomId);
    const connectPromise = tiktok.connect(roomId);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TikTok WebSocket connection timed out after 15000ms")), 15000)
    );
    const result = await Promise.race([connectPromise, timeoutPromise]);

    console.log("=== TIKTOK CONNECT() RESOLVED ===");
    console.log(result);

    // Some connector versions resolve connect() with the connected state.
    // Do not depend exclusively on the event emitter to activate the game.
    if (result?.roomId) lastRoomId = String(result.roomId);

    if (result?.isConnected === true && tiktokStatus !== "connected") {
      console.log("=== TIKTOK CONNECT RESULT CONFIRMED ===");
      tiktokStatus = "connected";
      tiktokError = "";
      gameActive = true;
      round++;
      roundStarted = Date.now();
      players.clear();
      totalLikes = 0;
      totalGifts = 0;
      giftStats.clear();
      events = [];
      pushEvent(`🟢 Connected to @${username} — game is LIVE!`, "system");
      broadcastState();
    }

  } catch (err) {
    console.error("=== TIKTOK CONNECT FAILED ===");
    console.error(err);

    if (tiktok) {
      try {
        await Promise.race([
          tiktok.disconnect(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      } catch {}
      tiktok = null;
    }

    tiktokStatus = "error";
    gameActive = false;
    const message = String(err?.message || err || "Unknown TikTok connection error");
    tiktokError = message.length > 240 ? message.slice(0, 237) + "..." : message;
    console.log("TikTok connection attempt failed. Will retry automatically in 5 seconds.");
    console.log("Reason:", tiktokError);
    broadcastState();
  } finally {
    reconnectInProgress = false;
  }
}
function scheduleTikTokReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (tiktokStatus === "connected" || reconnectInProgress) return;
    await connectTikTok();
  }, 3000);
}
function updateArenaPhysics() {
  const active = [...players.values()].filter(p => p.alive);
  for (const p of active) {
    p.x += p.vx || 0; p.y += p.vy || 0; p.angle = (p.angle || 0) + (p.spin || 0);
    if (p.x < 7) { p.x = 7; p.vx = Math.abs(p.vx || 0.12); }
    if (p.x > 93) { p.x = 93; p.vx = -Math.abs(p.vx || 0.12); }
    if (p.y < 12) { p.y = 12; p.vy = Math.abs(p.vy || 0.10); }
    if (p.y > 84) { p.y = 84; p.vy = -Math.abs(p.vy || 0.10); }
  }
  for (let i=0;i<active.length;i++) for (let j=i+1;j<active.length;j++) {
    const a=active[i], b=active[j], dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy), minDist=10.5;
    if (dist>0 && dist<minDist) {
      const nx=dx/dist, ny=dy/dist, overlap=minDist-dist;
      a.x-=nx*overlap/2; a.y-=ny*overlap/2; b.x+=nx*overlap/2; b.y+=ny*overlap/2;
      const avx=a.vx||0, avy=a.vy||0, bvx=b.vx||0, bvy=b.vy||0, rel=(bvx-avx)*nx+(bvy-avy)*ny;
      if(rel<0){a.vx+=nx*rel; a.vy+=ny*rel; b.vx-=nx*rel; b.vy-=ny*rel;}
      const t=now();
      if(t-(a.lastCollision||0)>650 || t-(b.lastCollision||0)>650){
        a.lastCollision=b.lastCollision=t; a.combo=0; b.combo=0; a.score+=3; b.score+=3;

        // Botsingen tussen vijandelijke teams doen directe HP-schade.
        // De cooldown voorkomt dat twee spelers meerdere keren per seconde schade oplopen.
        let damageA = 0, damageB = 0;
        if (a.team !== b.team) {
          const impactSpeed = Math.min(2.5, Math.max(0.6, Math.abs(rel)));
          const collisionDamage = Math.round(6 + impactSpeed * 4);
          damageA = Math.min(a.hp, collisionDamage);
          damageB = Math.min(b.hp, collisionDamage);
          a.hp -= damageA;
          b.hp -= damageB;
          a.score += damageB;
          b.score += damageA;

          if (a.hp <= 0) {
            a.hp = 0; a.alive = false;
            pushEvent("☠️ "+a.name+" valt uit door de botsing!","ko");
            setTimeout(() => {
              if (players.has(a.id)) {
                a.hp = a.maxHp; a.alive = true; a.energy = 0;
                a.x = 10 + Math.random() * 80; a.y = 17 + Math.random() * 58;
              }
            }, 5000);
          }
          if (b.hp <= 0) {
            b.hp = 0; b.alive = false;
            pushEvent("☠️ "+b.name+" valt uit door de botsing!","ko");
            setTimeout(() => {
              if (players.has(b.id)) {
                b.hp = b.maxHp; b.alive = true; b.energy = 0;
                b.x = 10 + Math.random() * 80; b.y = 17 + Math.random() * 58;
              }
            }, 5000);
          }
        }

        broadcast({
          type:"action",
          action:"collision",
          a:a.id,
          b:b.id,
          damageA,
          damageB
        });
        if (a.team !== b.team) {
          pushEvent("💥 "+a.name+" botst tegen "+b.name+"! -"+damageA+" HP / -"+damageB+" HP","collision");
        } else {
          pushEvent("💥 "+a.name+" botst tegen "+b.name+"!","collision");
        }
      }
    }
  }
}
function resetRound() {
  round++;
  roundStarted = now();
  for (const p of players.values()) {
    p.hp = p.maxHp; p.alive = true; p.energy = 0; p.combo = 0;
    p.x = 10 + Math.random() * 80; p.y = 17 + Math.random() * 58; p.vx=(Math.random()*2-1)*0.22; p.vy=(Math.random()*2-1)*0.16; p.angle=Math.random()*360;
  }
  pushEvent(`🏁 Ronde ${round} begint!`, "round");
  broadcastState();
}

async function launchLivePreviewBrowser() {
  const browser = await playwright.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true
  });
  browser.on("disconnected", () => {
    if (livePreviewBrowser === browser) {
      livePreviewBrowser = null;
      livePreviewPage = null;
    }
  });
  return browser;
}

async function _getLivePreviewPage() {
  if (livePreviewPage && !livePreviewPage.isClosed() && livePreviewBrowser?.isConnected()) {
    return livePreviewPage;
  }

  livePreviewPage = null;
  if (livePreviewBrowser && !livePreviewBrowser.isConnected()) {
    livePreviewBrowser = null;
  }
  if (!livePreviewBrowser) {
    livePreviewBrowser = await launchLivePreviewBrowser();
  }

  try {
    livePreviewPage = await livePreviewBrowser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1
    });
  } catch (err) {
    try { await livePreviewBrowser.close(); } catch {}
    livePreviewBrowser = await launchLivePreviewBrowser();
    livePreviewPage = await livePreviewBrowser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1
    });
  }

  await livePreviewPage.goto(
    `https://www.tiktok.com/@${encodeURIComponent(config.tiktokUsername)}/live`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );

  await livePreviewPage.waitForTimeout(1500);
  const consentTexts = [
    "Accept all", "Accept", "I agree", "Agree",
    "Alles accepteren", "Accepteren", "Akkoord", "Ik ga akkoord",
    "Allow all", "Toestaan"
  ];
  for (const label of consentTexts) {
    try {
      const buttons = livePreviewPage.getByRole("button", { name: new RegExp(label, "i") });
      const count = await buttons.count();
      for (let n = 0; n < count; n++) {
        if (await buttons.nth(n).isVisible().catch(() => false)) {
          await buttons.nth(n).click({ timeout: 2000 }).catch(() => {});
        }
      }
    } catch {}
  }
  for (const label of consentTexts) {
    try {
      const links = livePreviewPage.getByText(new RegExp("^" + label + "$", "i"));
      const count = await links.count();
      for (let n = 0; n < count; n++) {
        if (await links.nth(n).isVisible().catch(() => false)) {
          await links.nth(n).click({ timeout: 2000 }).catch(() => {});
        }
      }
    } catch {}
  }
  await livePreviewPage.waitForTimeout(3500);
  return livePreviewPage;
}
async function getLivePreviewPage() {
  // Only one Playwright/Chromium initialization may run at a time.
  // Render can return ETXTBSY when two requests try to spawn /tmp/chromium together.
  if (livePreviewInitPromise) return livePreviewInitPromise;
  livePreviewInitPromise = _getLivePreviewPage().finally(() => {
    livePreviewInitPromise = null;
  });
  return livePreviewInitPromise;
}

async function getLivePreviewBrowser() {
  if (livePreviewBrowser?.isConnected()) return livePreviewBrowser;
  if (livePreviewInitPromise) {
    await livePreviewInitPromise.catch(() => {});
    if (livePreviewBrowser?.isConnected()) return livePreviewBrowser;
  }
  if (!livePreviewBrowser) {
    livePreviewBrowser = await launchLivePreviewBrowser();
  }
  return livePreviewBrowser;
}
app.get("/api/live-preview.jpg", async (_,res) => {
  if (!config.tiktokUsername) return res.status(400).json({ok:false,error:"TikTok username is not configured"});
  if (livePreviewBusy) return res.status(429).end();
  livePreviewBusy = true;
  try {
    const page = await getLivePreviewPage();
    const url = `https://www.tiktok.com/@${encodeURIComponent(config.tiktokUsername)}/live`;
    if (!page.url().includes(`/@${encodeURIComponent(config.tiktokUsername)}/live`)) {
      await page.goto(url, { waitUntil:"domcontentloaded", timeout:30000 });
      await page.waitForTimeout(3000);
    }
    const jpg = await page.screenshot({type:"jpeg",quality:72});
    res.set("Cache-Control","no-store, no-cache, must-revalidate");
    res.type("image/jpeg").send(jpg);
  } catch (err) {
    console.error("LIVE preview error:", err?.message || err);
    try { await livePreviewPage?.close(); } catch {}
    livePreviewPage = null;
    res.status(503).json({ok:false,error:String(err?.message || err)});
  } finally {
    livePreviewBusy = false;
  }
});

app.get("/api/state", (_,res) => res.json(serialize()));
app.get("/api/config", (_,res) => res.json(config));
app.post("/api/config", async (req,res) => {
  const incoming = req.body || {};
  if (typeof incoming.tiktokUsername === "string")
    config.tiktokUsername = incoming.tiktokUsername.replace(/^@/,"").trim();
  if (typeof incoming.demoMode === "boolean") config.demoMode = incoming.demoMode;
  if (Number.isFinite(Number(incoming.roundSeconds)))
    config.roundSeconds = Math.max(30, Math.min(600, Number(incoming.roundSeconds)));
  if (Number.isFinite(Number(incoming.maxPlayers)))
    config.maxPlayers = Math.max(1, Math.min(200, Number(incoming.maxPlayers)));
  if (Number.isFinite(Number(incoming.commentCooldownMs)))
    config.commentCooldownMs = Math.max(0, Number(incoming.commentCooldownMs));
  if (Number.isFinite(Number(incoming.likeCooldownMs)))
    config.likeCooldownMs = Math.max(0, Number(incoming.likeCooldownMs));
  if (incoming.commands && typeof incoming.commands === "object") {
    config.commands = { ...config.commands, ...incoming.commands };
  }
  if (incoming.gifts && typeof incoming.gifts === "object") {
    config.gifts = { ...config.gifts, ...incoming.gifts };
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  await connectTikTok();
  res.json({ok:true, config, status:tiktokStatus});
});
app.post("/api/reset", (_,res) => { players.clear(); round=1; roundStarted=now(); events=[]; totalLikes=0; totalGifts=0; giftStats.clear(); nextPlayerId=1; pushEvent("🔄 Spel gereset.", "system"); res.json({ok:true}); });
app.get("/monitor", (_,res) => res.sendFile(path.join(__dirname, "public", "monitor.html")));
app.post("/api/control", async (req,res) => {
  const action=normalize(req.body?.action);
  if(action==="reset"){players.clear();round=1;roundStarted=now();events=[];totalLikes=0;totalGifts=0;giftStats.clear();nextPlayerId=1;pushEvent("🔄 Spel gereset door monitor.","system");}
  else if(action==="reconnect"){await connectTikTok();}
  else if(action==="music"){musicOn = typeof req.body?.enabled === "boolean" ? req.body.enabled : !musicOn;broadcast({type:"action",action:"music",enabled:musicOn});}
  else if(action==="demo"){
    const names=["Luna","Rico","Mila","Daan","Noah","Jay","Sanne","Max","Kai","Nova"];
    const a=req.body?.gameAction||"attack";
    // The control-room visual tests for the BOYS/GIRLS screen are isolated from
    // the legacy combat actions. They only emit the exact frontend visual event.
    if(a==="boys" || a==="girls") {
      const team = a==="boys" ? "red" : "blue";
      const p = getOrCreate(req.body?.name||"Test Viewer","monitor-team-"+Date.now());
      p.team = team;
      broadcast({type:"action",action:"team",player:p.id,team,name:p.name});
      pushEvent((team==="red"?"🔴 ":"🔵 ")+p.name+" joins "+(team==="red"?"BOYS":"GIRLS")+" (test)","join");
    } else if(a==="like") {
      broadcast({type:"action",action:"like",player:"test-like",team:req.body?.team==="blue"?"blue":"red",count:1,likeCount:1,name:req.body?.name||"Test Viewer",finalBattle:false});
    } else if(a==="gift") {
      broadcast({type:"action",action:"giftReceived",player:"test-gift",team:req.body?.team==="red"?"red":"blue",name:req.body?.name||"Test Viewer",giftName:req.body?.giftName||"Rose",count:1});
    } else {
      const p=getOrCreate(req.body?.name||names[Math.floor(Math.random()*names.length)],"monitor-demo-"+Date.now());
      if(a==="boss"){p.energy=100;boss(p);} else command(p,a);
    }
  }
  broadcastState(); res.json({ok:true,status:tiktokStatus});
});
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
app.post("/api/player-control", (req,res) => {
  const id = Number(req.body?.id), p = players.get(id), action = normalize(req.body?.action);
  if (!p) return res.status(404).json({ok:false,error:"Player not found"});
  if (action==="boys") {
    p.team="red";
    broadcast({type:"action",action:"team",player:p.id,team:"red",name:p.name});
    pushEvent("🔴 "+p.name+" naar BOYS gezet door monitor.","join");
  }
  else if (action==="girls") {
    p.team="blue";
    broadcast({type:"action",action:"team",player:p.id,team:"blue",name:p.name});
    pushEvent("🔵 "+p.name+" naar GIRLS gezet door monitor.","join");
  }
  else if (action==="remove") { players.delete(p.id); pushEvent("🗑️ "+p.name+" verwijderd door monitor.","system"); }
  else return res.status(400).json({ok:false,error:"Unknown action"});
  broadcastState(); res.json({ok:true});
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

// Game physics blijft op 20 FPS, maar volledige WebSocket-state gaat op 10 FPS.
// Dit voorkomt onnodig hoge CPU/bandbreedtebelasting op de Render free tier.
let lastStateBroadcast = 0;
setInterval(() => {
  updateArenaPhysics();
  if (gameActive && now() - roundStarted >= Number(config.roundSeconds || 120)*1000) resetRound();
  if (now() - lastStateBroadcast >= 100) {
    lastStateBroadcast = now();
    broadcastState();
  }
}, 50);

server.listen(PORT, async () => {
  console.log(`Battle Arena v2 running on http://localhost:${PORT}`);
  await connectTikTok();
  scheduleTikTokReconnect();
});
