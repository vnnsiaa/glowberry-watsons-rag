/**
 * Glowberry server persisten (Express).
 *
 * Dipakai untuk:
 *  1. Menjalankan website + API chatbot secara lokal (`npm start`).
 *  2. WhatsApp Gateway (whatsapp-web.js) yang membutuhkan proses Node.js
 *     yang hidup terus + browser Chromium. Bagian ini TIDAK bisa berjalan
 *     di Vercel Serverless Functions, sehingga dijalankan terpisah
 *     (lokal / VPS / Render / Railway). Lihat README.md.
 */
require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { GlowberryChatbot } = require("./lib/chatbot");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || path.join(__dirname, ".wwebjs_auth"));
const CACHE_DIR = path.resolve(process.env.WA_CACHE_DIR || path.join(__dirname, ".wwebjs_cache"));

const chatbot = new GlowberryChatbot();
const ragEngine = chatbot.ragEngine;

// ================= MIDDLEWARE =================

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    // Tanpa ALLOWED_ORIGINS: semua origin diizinkan (mode pengembangan lokal)
    origin: allowedOrigins.length
      ? (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
      : true,
    allowedHeaders: ["Content-Type", "X-Admin-Token"]
  })
);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Endpoint kontrol bot dilindungi ADMIN_TOKEN (jika diset)
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.get("X-Admin-Token") === ADMIN_TOKEN) return next();
  return res.status(401).json({ success: false, error: "Token admin tidak valid." });
}

// ================= STATE WHATSAPP BOT =================
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;
let lastError = null;

// ================= CONVERSATION HISTORY (MULTI-TURN MEMORY) =================
// Riwayat per nomor pengirim, maksimal 6 pesan, kedaluwarsa setelah 20 menit.
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000;

function getUserHistory(senderId) {
  if (!senderId) return [];
  const session = conversationHistory.get(senderId);
  if (!session) return [];

  if (Date.now() - session.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }
  return session.messages;
}

function appendUserHistory(senderId, userMsg, botReply) {
  if (!senderId) return;
  const now = Date.now();
  let session = conversationHistory.get(senderId);

  if (!session || now - session.lastActive > SESSION_TTL_MS) {
    session = { messages: [], lastActive: now };
  }

  session.messages.push({ role: "user", content: userMsg });
  session.messages.push({ role: "assistant", content: botReply });
  session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  session.lastActive = now;
  conversationHistory.set(senderId, session);
}

// Format teks untuk WhatsApp: **tebal** -> *tebal*, rapikan baris kosong
function formatWhatsAppMessage(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getWhatsAppReply(senderId, message) {
  const history = getUserHistory(senderId);
  const result = await chatbot.reply(message, { history });
  const reply = formatWhatsAppMessage(result.reply);
  appendUserHistory(senderId, message, reply);
  return reply;
}

// Masking nomor telepon (contoh: 08xxxxxx1234)
function maskPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  const formatted = String(rawNumber).replace(/^62/, "08");
  if (formatted.length < 8) return formatted;
  return `${formatted.slice(0, 2)}${"x".repeat(formatted.length - 6)}${formatted.slice(-4)}`;
}

// ================= WHATSAPP CLIENT =================

function initializeClient() {
  if (client) return client;

  // Dimuat saat dibutuhkan agar server tetap bisa jalan walau Chromium belum terpasang
  const { Client, LocalAuth } = require("whatsapp-web.js");
  const qrcode = require("qrcode-terminal");

  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "chatbot-rag", dataPath: SESSION_DIR }),
    webVersionCache: { type: "local", path: CACHE_DIR },
    puppeteer: puppeteerOptions
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("Pindai QR code di atas atau melalui Admin Dashboard di website.");
    console.log("==================================================\n");
  });

  client.on("authenticated", () => console.log("Autentikasi WhatsApp berhasil."));

  client.on("auth_failure", msg => {
    console.error("Autentikasi WhatsApp gagal:", msg);
    lastError = "Autentikasi WhatsApp gagal. Coba Reset Sesi lalu pindai QR ulang.";
    isInitializing = false;
  });

  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    lastError = null;
    console.log("Bot WhatsApp siap digunakan");
  });

  client.on("disconnected", async reason => {
    console.log("WhatsApp terputus:", reason);
    const oldClient = client;
    isReady = false;
    qrCodeData = null;
    client = null;
    try {
      if (oldClient) await oldClient.destroy();
    } catch {
      // browser mungkin sudah tertutup
    }
  });

  // Hanya membalas chat pribadi (bukan grup / status)
  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;

      const isPersonalChat = msg.from.endsWith("@c.us") || msg.from.endsWith("@lid");
      if (!isPersonalChat || msg.from === "status@broadcast") return;

      const message = msg.body.trim().slice(0, 1000);
      console.log(`[WA masuk ${maskPhoneNumber(msg.from.split("@")[0])}]: ${message}`);

      const reply = await getWhatsAppReply(msg.from, message);
      await msg.reply(reply);
      console.log(`[WA terkirim]: ${reply.slice(0, 120)}${reply.length > 120 ? "..." : ""}`);
    } catch (err) {
      console.error("Error memproses pesan:", err);
      try {
        await msg.reply("Mohon maaf Kak, sistem Glowberry sedang mengalami gangguan. Silakan coba lagi sebentar ya. 💗");
      } catch (replyErr) {
        console.error("Gagal mengirim pesan error fallback:", replyErr);
      }
    }
  });

  return client;
}

function startClient() {
  isInitializing = true;
  lastError = null;
  const waClient = initializeClient();

  // initialize() bisa lama (membuka Chromium); jangan menahan request HTTP
  waClient.initialize().catch(async err => {
    console.error("Gagal memulai bot WhatsApp:", err);
    lastError = `Gagal memulai bot: ${err.message}`;
    isInitializing = false;
    // Tutup Chromium yang sudah terbuka agar tidak bocor & tidak mengunci folder sesi
    try {
      await waClient.destroy();
    } catch {
      // browser mungkin belum sempat terbuka
    }
    if (client === waClient) client = null;
  });
}

// ================= API: CHATBOT & KATALOG =================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    runtime: "server",
    products: ragEngine.loadData().length,
    knowledgeTopics: Object.keys(chatbot.loadKnowledge().responses || {}).length,
    groqConfigured: chatbot.isConfigured(),
    model: chatbot.primaryModel(),
    whatsappGateway: true
  });
});

// Website yang dilayani server ini memakai gateway di origin yang sama
app.get(["/api/config", "/api/config.js"], (req, res) => {
  res.json({ success: true, runtime: "server", waGatewayUrl: "" });
});

app.post(["/api/chat", "/api/chat.js"], async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ success: false, error: "Pesan tidak boleh kosong." });
  }
  if (message.length > 1000) {
    return res.status(413).json({ success: false, error: "Pesan terlalu panjang (maksimal 1000 karakter)." });
  }

  try {
    const result = await chatbot.reply(message);
    return res.json({ success: true, reply: result.reply, source: result.source });
  } catch (error) {
    console.error("Chat API Error:", error);
    return res.status(500).json({ success: false, error: "Maaf, Glowberry sedang mengalami gangguan." });
  }
});

app.get(["/api/products", "/api/products.js"], (req, res) => {
  const products = ragEngine.loadData();
  if (!products.length) {
    return res.status(503).json({ success: false, error: "Katalog produk belum tersedia." });
  }
  res.json({ success: true, total: products.length, categories: ragEngine.getCategories(), products });
});

app.get(["/api/knowledge", "/api/knowledge.js"], (req, res) => {
  res.json({ success: true, ...chatbot.loadKnowledge() });
});

app.get(["/api/groq/quota", "/api/groq/quota.js"], async (req, res) => {
  try {
    const quota = req.query.fresh === "true" ? await chatbot.refreshQuota() : chatbot.getQuota();
    res.json({ success: true, ...quota });
  } catch (err) {
    console.error("Error cek kuota Groq:", err);
    res.status(500).json({ success: false, error: "Gagal memeriksa kuota Groq." });
  }
});

// ================= API: WHATSAPP GATEWAY =================

app.get("/api/bot/status", (req, res) => {
  let botNumber = null;
  if (isReady && client && client.info && client.info.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }

  res.json({
    success: true,
    isReady,
    isInitializing,
    isCleaning,
    hasQRCode: Boolean(qrCodeData),
    botNumber,
    lastError,
    adminTokenRequired: Boolean(ADMIN_TOKEN)
  });
});

app.get("/api/bot/qr", requireAdmin, (req, res) => {
  res.json({ success: true, qr: qrCodeData });
});

app.post("/api/bot/start", requireAdmin, (req, res) => {
  if (isCleaning) {
    return res.status(409).json({ success: false, error: "Sesi sedang dibersihkan, coba lagi sebentar." });
  }
  if (isReady) return res.json({ success: true, message: "Bot sudah berjalan." });
  if (isInitializing || client) {
    return res.json({ success: true, message: "Bot sedang proses inisialisasi..." });
  }

  try {
    startClient();
    return res.json({ success: true, message: "Bot sedang dimulai. Tunggu kode QR muncul (10-60 detik)." });
  } catch (err) {
    isInitializing = false;
    client = null;
    console.error("Gagal memulai bot:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bot/stop", requireAdmin, async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;
    if (client) await client.destroy();
    client = null;
    res.json({ success: true, message: "Bot WhatsApp dihentikan." });
  } catch (err) {
    client = null;
    console.error("Gagal menghentikan bot:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isCleaning = false;
  }
});

// Reset sesi (hapus sesi yang nyangkut / logout) -> perlu scan QR ulang
app.post("/api/bot/reset", requireAdmin, async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;

    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.warn("Peringatan saat destroy client:", e.message);
      }
      client = null;
    }

    for (const dir of [SESSION_DIR, CACHE_DIR]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[Reset Session]: ${path.basename(dir)} dihapus`);
      }
    }

    conversationHistory.clear();
    lastError = null;
    res.json({ success: true, message: "Sesi WhatsApp berhasil dibersihkan. Klik Mulai Bot untuk memindai QR baru." });
  } catch (err) {
    console.error("Gagal mereset sesi bot:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isCleaning = false;
  }
});

// 404 JSON untuk API yang tidak dikenal
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, error: "Endpoint tidak ditemukan." });
});

// Error handler JSON (mis. body JSON tidak valid / terlalu besar)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("Server error:", err);
  res.status(status).json({
    success: false,
    error: status === 400 ? "Format JSON tidak valid." : status === 413 ? "Permintaan terlalu besar." : "Terjadi kesalahan server."
  });
});

// ================= JALANKAN SERVER =================

function start() {
  const server = app.listen(PORT, () => {
    console.log(`Server Glowberry berjalan di http://localhost:${PORT}`);
    if (!chatbot.isConfigured()) {
      console.warn("GROQ_API_KEY belum diset: chatbot memakai jawaban fallback dari katalog.");
    }
    if (!ADMIN_TOKEN) {
      console.warn("ADMIN_TOKEN belum diset: kontrol bot WhatsApp tidak dilindungi (aman hanya untuk lokal).");
    }
    if (process.env.AUTO_START_BOT === "true") {
      console.log("AUTO_START_BOT aktif, memulai bot WhatsApp...");
      startClient();
    }
  });

  // Penutupan bersih (mencegah proses Chrome tertinggal)
  async function gracefulShutdown(signal) {
    console.log(`\nMenerima sinyal ${signal}, membersihkan proses...`);
    if (client) {
      try {
        await client.destroy();
        console.log("Koneksi WhatsApp & browser Chrome ditutup.");
      } catch {
        // abaikan jika sudah tertutup
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start, formatWhatsAppMessage, maskPhoneNumber };
