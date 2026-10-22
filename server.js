import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
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
  connection = new TikTokLiveConnection(state.username, { processInitialData: false, logFetchFallbackErrors: true });
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
    const result = await connection.connect();
    state.connected = true;
    state.roomId = String(result?.roomId || connection.roomId || "");
    logEvent("system", "Connected to @" + state.username + "'s LIVE.");
    emitState();
  } catch (error) {
    state.connected = false;
    state.error = safe(error?.message || error, 500);
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
