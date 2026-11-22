import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { GoogleGenAI } from "@google/genai";

const PORT = process.env.PORT || 3000;
const MODEL = "gemini-2.5-flash";
const BATCH_SIZE = 50;
const ACTIONS = ["play", "pause", "seek", "buffering", "change_source"];

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// roomId -> { roomId, hostId, users: Map, videoState }
const rooms = new Map();

/* ---------- Helpers ---------- */

const reply = (cb, data) => {
  if (typeof cb === "function") cb(data);
};

const cleanName = (name) =>
  String(name || "Guest").trim().slice(0, 24) || "Guest";

function makeRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(id));
  return id;
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    users: Array.from(room.users.values()),
    videoState: room.videoState,
  };
}

function getRoom(socket) {
  const roomId = socket.data.roomId;
  return roomId ? rooms.get(roomId) : null;
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  socket.leave(roomId);
  socket.data.roomId = null;

  const room = rooms.get(roomId);
  if (!room) return;

  room.users.delete(socket.id);
  if (room.users.size === 0) {
    rooms.delete(roomId);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.users.keys().next().value;
    io.to(roomId).emit("host_changed", { hostId: room.hostId });
  }
  io.to(roomId).emit("user_left", {
    socketId: socket.id,
    room: publicRoom(room),
  });
}

/* ---------- HTTP routes ---------- */

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

function parseSrt(srt) {
  const blocks = srt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const t = lines.findIndex((l) => l.includes("-->"));
    if (t === -1) continue;
    cues.push({
      id: t > 0 ? lines[0].trim() : String(cues.length + 1),
      time: lines[t].trim().replace(/,/g, "."),
      text: lines.slice(t + 1).join("\n").trim(),
    });
  }
  return cues;
}

async function translateBatch(batch, language) {
  const input = batch.map((c) => c.text);
  const prompt =
    `Translate these movie subtitle lines into ${language}. ` +
    `Make the dialogue sound natural and conversational, not literal. ` +
    `Keep all numbers, names, and HTML tags exactly as they are. ` +
    `Keep line breaks as \\n. ` +
    `Return ONLY a JSON array of exactly ${input.length} strings, ` +
    `in the same order as the input.\n\n` +
    JSON.stringify(input);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { responseMimeType: "application/json", temperature: 0.2 },
      });
      const out = JSON.parse(response.text);
      if (Array.isArray(out) && out.length === input.length) {
        return out.map((s) => String(s).trim());
      }
      console.error(`Batch length mismatch (attempt ${attempt})`);
    } catch (err) {
      console.error(`Batch translate failed (attempt ${attempt}):`, err.message);
    }
  }
  return input; // fall back to original text for this batch
}

app.post("/api/translate-subtitles", async (req, res) => {
  const { srtText, targetLanguage } = req.body || {};

  if (typeof srtText !== "string" || !srtText.trim()) {
    return res.status(400).json({ error: "srtText is required" });
  }
  if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
    return res.status(400).json({ error: "targetLanguage is required" });
  }
  if (!ai) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set" });
  }

  try {
    const cues = parseSrt(srtText);
    if (cues.length === 0) {
      return res.status(400).json({ error: "No valid SRT blocks found" });
    }

    const language = targetLanguage.trim().slice(0, 50);
    const translated = [];
    for (let i = 0; i < cues.length; i += BATCH_SIZE) {
      const batch = cues.slice(i, i + BATCH_SIZE);
      translated.push(...(await translateBatch(batch, language)));
    }

    const body = cues
      .map((c, i) => `${c.id}\n${c.time}\n${translated[i]}`)
      .join("\n\n");

    res.type("text/vtt").send(`WEBVTT\n\n${body}\n`);
  } catch (err) {
    console.error("Translate error:", err);
    res.status(500).json({ error: "Translation failed" });
  }
});

/* ---------- Socket.io ---------- */

io.on("connection", (socket) => {
  socket.on("create_room", (payload, cb) => {
    leaveRoom(socket);
    const roomId = makeRoomId();
    const user = { id: socket.id, username: cleanName(payload?.username) };
    const room = {
      roomId,
      hostId: socket.id,
      users: new Map([[socket.id, user]]),
      videoState: {
        source: null,
        playing: false,
        currentTime: 0,
        updatedAt: Date.now(),
      },
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    reply(cb, { ok: true, yourId: socket.id, room: publicRoom(room) });
  });

  socket.on("join_room", (payload, cb) => {
    const roomId = String(payload?.roomId || "").trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) return reply(cb, { ok: false, error: "Room not found" });

    if (socket.data.roomId !== roomId) leaveRoom(socket);

    const user = { id: socket.id, username: cleanName(payload?.username) };
    room.users.set(socket.id, user);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.to(roomId).emit("user_joined", { user, room: publicRoom(room) });
    reply(cb, { ok: true, yourId: socket.id, room: publicRoom(room) });
  });

  socket.on("video_action", (payload) => {
    const room = getRoom(socket);
    if (!room || !payload || !ACTIONS.includes(payload.action)) return;

    const vs = room.videoState;
    if (typeof payload.time === "number") vs.currentTime = payload.time;
    if (payload.action === "play") vs.playing = true;
    if (payload.action === "pause") vs.playing = false;
    if (payload.action === "change_source") {
      vs.source = payload.source ?? null;
      vs.currentTime = 0;
      vs.playing = false;
    }
    vs.updatedAt = Date.now();

    socket.to(room.roomId).emit("video_action", { ...payload, from: socket.id });
  });

  socket.on("host_heartbeat", (payload) => {
    const room = getRoom(socket);
    if (!room || room.hostId !== socket.id || !payload) return;

    const vs = room.videoState;
    if (typeof payload.time === "number") vs.currentTime = payload.time;
    if (typeof payload.playing === "boolean") vs.playing = payload.playing;
    vs.updatedAt = Date.now();

    socket.to(room.roomId).emit("host_heartbeat", {
      ...payload,
      from: socket.id,
      serverTime: vs.updatedAt,
    });
  });

  socket.on("chat_message", (payload) => {
    const room = getRoom(socket);
    const text = String(payload?.text || "").trim().slice(0, 500);
    if (!room || !text) return;

    io.to(room.roomId).emit("chat_message", {
      id: `${socket.id}-${Date.now()}`,
      from: socket.id,
      username: room.users.get(socket.id)?.username || "Guest",
      text,
      timestamp: Date.now(),
    });
  });

  socket.on("emoji_reaction", (payload) => {
    const room = getRoom(socket);
    const emoji = String(payload?.emoji || "").trim().slice(0, 8);
    if (!room || !emoji) return;

    io.to(room.roomId).emit("emoji_reaction", {
      from: socket.id,
      username: room.users.get(socket.id)?.username || "Guest",
      emoji,
      timestamp: Date.now(),
    });
  });

  const relayWebRTC = (eventName, dataKey) => {
    socket.on(eventName, (payload) => {
      const room = getRoom(socket);
      const target = payload?.toSocketId;
      if (!room || !target || !room.users.has(target)) return;

      io.to(target).emit(eventName, {
        fromSocketId: socket.id,
        [dataKey]: payload[dataKey],
      });
    });
  };

  relayWebRTC("webrtc_offer", "offer");
  relayWebRTC("webrtc_answer", "answer");
  relayWebRTC("webrtc_ice_candidate", "candidate");

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`WatchParty backend listening on port ${PORT}`);
});
