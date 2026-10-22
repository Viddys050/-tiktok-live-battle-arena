import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);

const state = {
  connected: false,
  username: "",
  roomId: "",
  likesTotal: 0,
  viewers: 0,
  giftEvents: 0,
  gifts: [],
  chat: [],
  events: [],
  supporters: {},
  error: ""
};
let connection = null;
const safe = (value, max = 300) => String(value ?? "").replace(/[<>]/g, "").slice(0, max);
const addLatest = (array, item, max = 100) => {
  array.unshift(item);
  if (array.length > max) array.length = max;
};
const emitState = () => io.emit("state", state);

function logEvent(type, text, extra = {}) {
  const item = { id: Date.now() + Math.random(), time: new Date().toISOString(), type, text: safe(text), ...extra };
  addLatest(state.events, item);
  io.emit("event", item);
}

function handleChat(data) {
  const user = data?.user || {};
  const item = {
    time: new Date().toISOString(),
    username: safe(user.displayId || user.nickname || user.uniqueId || "viewer", 60),
    message: safe(data?.comment || data?.content || data?.text || "", 500)
  };
  addLatest(state.chat, item, 200);
  io.emit("chat", item);
  logEvent("chat", "@" + item.username + ": " + item.message, { username: item.username });
  emitState();
}

function handleGift(data) {
  const user = data?.user || {};
  const giftName = safe(data?.giftDetails?.giftName || data?.gift?.name || data?.extendedGiftInfo?.name || data?.giftName || "Gift", 100);
  const giftType = Number(data?.giftDetails?.giftType ?? data?.gift?.type ?? data?.giftType ?? 0);
  if (giftType === 1 && data?.repeatEnd !== true && Number(data?.repeatEnd) !== 1) return;

  const username = safe(user.displayId || user.nickname || user.uniqueId || "viewer", 60);
  const count = Math.max(1, Number(data?.repeatCount || 1));
  const diamondsEach = Math.max(0, Number(data?.giftDetails?.diamondCount ?? data?.gift?.diamondCount ?? data?.diamondCount ?? 0));
  const item = { time: new Date().toISOString(), username, name: giftName, count, diamonds: diamondsEach * count };
  addLatest(state.gifts, item, 150);
  state.giftEvents += count;
  const id = String(user.userId ?? user.id ?? user.uniqueId ?? username);
  if (!state.supporters[id]) state.supporters[id] = { username, gifts: 0, diamonds: 0 };
  state.supporters[id].username = username;
  state.supporters[id].gifts += count;
  state.supporters[id].diamonds += item.diamonds;
  io.emit("gift", item);
  logEvent("gift", "@" + username + " sent " + giftName + " ×" + count, { username, giftName, count });
  emitState();
}

function handleLike(data) {
  const count = Math.max(1, Number(data?.likeCount || 1));
  state.likesTotal += count;
  logEvent("like", "+" + count.toLocaleString("en-US") + " likes", { count, total: state.likesTotal });
  emitState();
}


async function resolveRoomId(username) {
  const patterns = [
    /"roomId"\s*:\s*"?([0-9]{10,})"?/i,
    /"room_id"\s*:\s*"?([0-9]{10,})"?/i,
    /webcast_id\D{0,100}([0-9]{10,})/i,
    /room_id=(\d{10,})/i
  ];
  const findId = value => {
    const body = String(value || "");
    for (const pattern of patterns) {
      const match = body.match(pattern);
      if (match?.[1]) return match[1];
    }
    return "";
  };

  // Fast path: TikTok may expose the room ID in the LIVE page HTML.
  try {
    const response = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(12000)
    });
    const html = await response.text();
    const id = findId(html);
    console.log("[Room lookup] TikTok HTML:", response.status, "bytes:", html.length, "roomId:", id || "not found");
    if (id) return id;
  } catch (error) {
    console.log("[Room lookup] direct TikTok request failed:", error?.message || error);
  }

  // Second path: ask TikRec for a signed TikTok room endpoint.
  // TikTok sometimes serves the LIVE page without embedding the room ID.
  const requestHeaders = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://www.tiktok.com/",
    "Origin": "https://www.tiktok.com",
    "Accept-Language": "en-US,en;q=0.9"
  };
  try {
    console.log("[Room lookup] Trying TikRec signed room lookup...");
    const signResponse = await fetch(`https://tikrec.com/tiktok/room/api/sign?unique_id=${encodeURIComponent(username)}`, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(10000)
    });
    const signText = await signResponse.text();
    console.log("[Room lookup] TikRec signer:", signResponse.status, "bytes:", signText.length);
    if (!signResponse.ok) throw new Error("signer HTTP " + signResponse.status);
    const signed = JSON.parse(signText);
    const signedUrl = signed?.signed_url || (signed?.signed_path ? "https://www.tiktok.com" + signed.signed_path : "");
    if (!signedUrl) throw new Error("signer returned no signed URL");
    const roomResponse = await fetch(signedUrl, {
      headers: requestHeaders,
      signal: AbortSignal.timeout(10000)
    });
    const roomText = await roomResponse.text();
    console.log("[Room lookup] Signed room API:", roomResponse.status, "bytes:", roomText.length);
    const data = JSON.parse(roomText);
    const id = data?.data?.room_info?.id ||
      data?.data?.roomInfo?.roomId ||
      data?.data?.room_info?.roomId ||
      data?.data?.user?.roomId ||
      data?.data?.liveRoom?.roomId ||
      data?.room_id ||
      findId(roomText);
    if (id && String(id).match(/^\d{10,}$/)) {
      console.log("[Room lookup] TikRec found room ID:", String(id));
      return String(id);
    }
    console.log("[Room lookup] TikRec response had no usable room ID; status:", data?.statusCode ?? data?.status_code ?? "unknown");
  } catch (error) {
    console.log("[Room lookup] TikRec lookup failed:", error?.message || error);
  }

  // Third path: TikTok's room endpoint. Use multiple browser/region parameters
  // because the endpoint can behave differently for mobile and desktop clients.
  try {
    console.log("[Room lookup] Trying TikTok room API...");
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
    const apiResponse = await fetch("https://www.tiktok.com/api-live/user/room/?" + params.toString(), {
      headers: requestHeaders,
      signal: AbortSignal.timeout(10000)
    });
    const apiText = await apiResponse.text();
    console.log("[Room lookup] TikTok room API:", apiResponse.status, "bytes:", apiText.length);
    const data = JSON.parse(apiText);
    const id = data?.data?.user?.roomId ||
      data?.data?.liveRoom?.roomId ||
      data?.data?.room_info?.id ||
      findId(apiText);
    if (id && String(id).match(/^\d{10,}$/) && !data?.statusCode) {
      console.log("[Room lookup] TikTok API found room ID:", String(id));
      return String(id);
    }
    console.log("[Room lookup] TikTok API returned no usable room ID; status:", data?.statusCode ?? data?.status_code ?? "unknown", data?.message || "");
  } catch (error) {
    console.log("[Room lookup] TikTok API lookup failed:", error?.message || error);
  }

  // Reliable fallback used by the earlier LIVE game: load TikTok in Chromium
  // and inspect both the page and TikTok's embedded hydration JSON.
  let browser;
  try {
    console.log("[Room lookup] Trying Chromium fallback for @" + username);
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    });
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      viewport: { width: 960, height: 540 }
    });
    const candidates = new Set();
    const inspect = value => {
      const body = String(value || "");
      for (const pattern of patterns) {
        for (const match of body.matchAll(new RegExp(pattern.source, "gi"))) {
          if (match[1]) candidates.add(match[1]);
        }
      }
      for (const match of body.matchAll(/(?:roomId|room_id|webcastId|webcast_id)[^0-9]{0,100}([0-9]{10,})/gi)) candidates.add(match[1]);
    };
    page.on("response", async response => {
      try {
        if (!/tiktok\.com/i.test(response.url())) return;
        inspect(response.url());
        if (/live|room|webcast|api-live/i.test(response.url())) inspect(await response.text());
      } catch {}
    });
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, {
      waitUntil: "domcontentloaded", timeout: 30000
    });
    await page.waitForTimeout(6500);
    inspect(page.url());
    inspect(await page.content());
    const scripts = await page.evaluate(() => ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "sigi-persisted-data", "SIGI_STATE"]
      .map(id => document.getElementById(id)?.textContent || "").filter(Boolean));
    for (const item of scripts) {
      inspect(item);
      try {
        const walk = (value, depth=0) => {
          if (!value || depth > 14) return;
          if (Array.isArray(value)) return value.forEach(v => walk(v, depth+1));
          if (typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (/^(roomId|room_id|roomID|webcastId|webcast_id)$/i.test(key)) {
              const id = String(child ?? "").match(/[0-9]{10,}/)?.[0];
              if (id) candidates.add(id);
            }
            walk(child, depth+1);
          }
        };
        walk(JSON.parse(item));
      } catch {}
    }
    await page.close().catch(() => {});
    if (candidates.size) {
      const id = [...candidates][0];
      console.log("[Room lookup] Chromium found room ID:", id);
      return id;
    }
    console.log("[Room lookup] LIVE page had no room ID; checking profile metadata...");
    try {
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
        waitUntil: "domcontentloaded", timeout: 20000
      });
      await page.waitForTimeout(3500);
      inspect(page.url());
      inspect(await page.content());
      const profileScripts = await page.evaluate(() => ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "sigi-persisted-data", "SIGI_STATE"]
        .map(id => document.getElementById(id)?.textContent || "").filter(Boolean));
      for (const item of profileScripts) {
        inspect(item);
        try {
          const walk = (value, depth=0) => {
            if (!value || depth > 16) return;
            if (Array.isArray(value)) return value.forEach(v => walk(v, depth+1));
            if (typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) {
              if (/^(roomId|room_id|roomID|webcastId|webcast_id)$/i.test(key)) {
                const id = String(child ?? "").match(/[0-9]{10,}/)?.[0];
                if (id) candidates.add(id);
              }
              walk(child, depth+1);
            }
          };
          walk(JSON.parse(item));
        } catch {}
      }
    } catch (error) {
      console.log("[Room lookup] Profile metadata check failed:", error?.message || error);
    }
    if (candidates.size) {
      const id = [...candidates][0];
      console.log("[Room lookup] Chromium profile found room ID:", id);
      return id;
    }
    console.log("[Room lookup] Chromium and profile did not expose a room ID.");
  } catch (error) {
    console.error("[Room lookup] Chromium fallback failed:", error?.message || error);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  throw new Error("Could not resolve TikTok LIVE room ID. TikTok may be blocking this server's requests.");
}

async function disconnect() {
  if (connection) {
    try { await connection.disconnect(); } catch {}
  }
  connection = null;
  state.connected = false;
  state.roomId = "";
  emitState();
}

async function connect(username) {
  await disconnect();
  state.username = safe(String(username || "").replace(/^@/, "").trim(), 80);
  if (!state.username) throw new Error("Enter your TikTok username without @.");
  state.likesTotal = 0;
  state.viewers = 0;
  state.giftEvents = 0;
  state.gifts = [];
  state.chat = [];
  state.events = [];
  state.supporters = {};
  state.error = "";
  connection = new TikTokLiveConnection(state.username, {
    processInitialData: false,
    logFetchFallbackErrors: true,
    connectWithUniqueId: true
  });
  connection.on(WebcastEvent.CHAT, handleChat);
  connection.on(WebcastEvent.GIFT, handleGift);
  connection.on(WebcastEvent.LIKE, handleLike);
  connection.on(WebcastEvent.ROOM_USER, data => {
    const viewers = Number(data?.viewerCount ?? data?.total ?? data?.userCount);
    if (Number.isFinite(viewers) && viewers >= 0) state.viewers = viewers;
    emitState();
  });
  connection.on(ControlEvent.ERROR, data => {
    state.error = safe(data?.info || data?.exception?.message || "TikTok connection error", 500);
    logEvent("system", state.error);
    emitState();
  });
  connection.on(ControlEvent.DISCONNECTED, () => {
    state.connected = false;
    logEvent("system", "TikTok LIVE connection disconnected.");
    emitState();
  });
  try {
    const roomId = await resolveRoomId(state.username);
    state.roomId = String(roomId);
    logEvent("system", "Found TikTok LIVE room ID. Connecting to LIVE…");
    emitState();
    const result = await connection.connect(roomId);
    state.connected = true;
    state.roomId = String(result?.roomId || connection.roomId || "");
    logEvent("system", "Connected to @" + state.username + "'s LIVE.");
    emitState();
  } catch (error) {
    state.connected = false;
    let requestErrors = "";
    try {
      const details = error?.errors || error?.requestErrors || error?.causes || error?.cause || connection?.config?.requestErrs;
      if (details) {
        requestErrors = JSON.stringify(details, (key, value) => {
          if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
          return value;
        });
      }
    } catch (detailError) {
      requestErrors = "Could not serialize diagnostic details: " + String(detailError?.message || detailError);
    }
    const message = String(error?.message || error);
    console.error("[TikTok LIVE connection failed]", {
      username: state.username,
      errorName: error?.name || "",
      message,
      requestErrors: requestErrors || "(connector did not expose nested errors)",
      stack: error?.stack || ""
    });
    state.error = safe(requestErrors ? message + " | Details: " + requestErrors : message, 1800);
    logEvent("system", "Connection failed: " + state.error);
    emitState();
    throw error;
  }
}

app.use(express.json({ limit: "32kb" }));
app.get("/", (_req, res) => res.sendFile(path.join(root, "public", "dashboard.html")));
app.get("/monitor", (_req, res) => res.sendFile(path.join(root, "public", "dashboard.html")));
app.get("/health", (_req, res) => res.json({ ok: true, connected: state.connected }));
app.get("/api/state", (_req, res) => res.json(state));
app.post("/api/connect", async (req, res) => {
  try {
    await connect(req.body?.username);
    res.json({ ok: true, connected: state.connected });
  } catch (error) {
    res.status(400).json({ ok: false, error: safe(error?.message || error, 500) });
  }
});
app.post("/api/disconnect", async (_req, res) => {
  await disconnect();
  logEvent("system", "Dashboard disconnected from TikTok LIVE.");
  res.json({ ok: true });
});
app.use(express.static(path.join(root, "public")));
io.on("connection", socket => {
  socket.emit("state", state);
  socket.emit("snapshot", { chat: state.chat, gifts: state.gifts, events: state.events });
});
server.listen(PORT, "0.0.0.0", () => console.log("TikTok LIVE Monitor listening on port " + PORT));
process.on("SIGINT", async () => { await disconnect(); server.close(() => process.exit(0)); });
