require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const RAGEngine = require("./lib/rag");
 
const app = express();
const PORT = process.env.PORT || 3001;
 
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
 
// Inisialisasi Groq SDK
let groq = null;
if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}
 
// Inisialisasi RAG Engine
const ragEngine = new RAGEngine(path.join(__dirname, "data/products.csv"));
 
// Load Knowledge Base
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");
let knowledge = { keywords: {}, responses: {} };
function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Gagal membaca knowledge.json:", err);
  }
}
loadKnowledge();
 
// State WhatsApp Bot
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;
 
// ================= KUOTA & RATE LIMIT GROQ AI =================
let groqQuota = {
  model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  remainingRequests: null,
  limitRequests: null,
  remainingTokens: null,
  limitTokens: null,
  resetRequests: null,
  lastChecked: null,
  configured: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq")
};
 
function updateGroqQuotaFromHeaders(headers, modelName) {
  if (!headers) return;
  groqQuota.model = modelName || process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  const remReq = headers.get ? headers.get("x-ratelimit-remaining-requests") : headers["x-ratelimit-remaining-requests"];
  const limReq = headers.get ? headers.get("x-ratelimit-limit-requests") : headers["x-ratelimit-limit-requests"];
  const remTok = headers.get ? headers.get("x-ratelimit-remaining-tokens") : headers["x-ratelimit-remaining-tokens"];
  const limTok = headers.get ? headers.get("x-ratelimit-limit-tokens") : headers["x-ratelimit-limit-tokens"];
  const rstReq = headers.get ? headers.get("x-ratelimit-reset-requests") : headers["x-ratelimit-reset-requests"];
 
  if (remReq) groqQuota.remainingRequests = Number(remReq);
  if (limReq) groqQuota.limitRequests = Number(limReq);
  if (remTok) groqQuota.remainingTokens = Number(remTok);
  if (limTok) groqQuota.limitTokens = Number(limTok);
  if (rstReq) groqQuota.resetRequests = rstReq;
  groqQuota.lastChecked = new Date().toLocaleTimeString("id-ID");
  groqQuota.configured = true;
}
 
async function fetchGroqQuotaFresh() {
  if (!groq) {
    if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
      groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      return groqQuota;
    }
  }
 
  const modelToUse = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  try {
    const { response } = await groq.chat.completions.create({
      model: modelToUse,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1
    }).withResponse();
 
    updateGroqQuotaFromHeaders(response.headers, modelToUse);
  } catch (err) {
    console.warn("Gagal mengecek kuota Groq:", err.message);
  }
  return groqQuota;
}
 
// ================= CONVERSATION HISTORY (MULTI-TURN MEMORY) =================
// Menyimpan riwayat percakapan per nomor pengirim (msg.from)
// Menggunakan sliding window (maks 6 pesan: 3 pertanyaan user & 3 respon bot)
// dan auto-expire setelah 20 menit tidak aktif.
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 menit
 
function getUserHistory(senderId) {
  if (!senderId) return [];
  const session = conversationHistory.get(senderId);
  const now = Date.now();
 
  if (!session) return [];
 
  // Jika sesi sudah tidak aktif lebih dari 20 menit, reset
  if (now - session.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }
 
  return session.messages || [];
}
 
function appendUserHistory(senderId, userMsg, botReply) {
  if (!senderId) return;
  const now = Date.now();
  let session = conversationHistory.get(senderId);
 
  if (!session || (now - session.lastActive > SESSION_TTL_MS)) {
    session = { messages: [], lastActive: now };
  }
 
  session.messages.push({ role: "user", content: userMsg });
  session.messages.push({ role: "assistant", content: botReply });
 
  // Batasi hanya menyimpan pesan terakhir
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  }
 
  session.lastActive = now;
  conversationHistory.set(senderId, session);
}
 
function initializeClient() {
  if (client) return client;
 
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "chatbot-rag"
    }),
    puppeteer: {
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
    }
  });
 
  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("Pindai QR code di atas atau melalui web dashboard.");
    console.log("==================================================\n");
  });
 
  client.on("authenticated", () => {
    console.log("Autentikasi WhatsApp berhasil.");
  });
 
  client.on("auth_failure", msg => {
    console.error("Autentikasi WhatsApp gagal:", msg);
    isInitializing = false;
  });
 
  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp siap digunakan");
  });
 
  client.on("disconnected", reason => {
    console.log("WhatsApp terputus:", reason);
    isReady = false;
    qrCodeData = null;
    client = null;
  });
 
  // Handler Pesan Pribadi
  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;
 
      const isPersonalChat =
        msg.from.endsWith("@c.us") ||
        msg.from.endsWith("@lid");
      const isNotStatus = !msg.from.endsWith("@status");
 
      if (!isPersonalChat || !isNotStatus) {
        console.log("Pesan grup/status diabaikan:", msg.from);
        return;
      }
 
      const message = msg.body.trim();
      console.log(`[Pesan Masuk dari ${msg.from}]: ${message}`);
 
      const reply = await getAIResponse(msg.from, message);
      await msg.reply(reply);
      console.log(`[Balasan Terkirim]: ${reply}`);
    } catch (err) {
      console.error("Error memproses pesan:", err);
      try {
        await msg.reply("Mohon maaf, saat ini sistem asisten sedang mengalami gangguan teknis. Silakan coba kembali sesaat lagi.");
      } catch (replyErr) {
        console.error("Gagal mengirim pesan error fallback:", replyErr);
      }
    }
  });
 
  return client;
}
 
// Helper Format Teks untuk WhatsApp (Bold *teks*, normalisasi spasi)
function formatWhatsAppMessage(text) {
  if (!text) return "";
  // 1. Ubah markdown bold double asterisks **teks** menjadi single asterisk *teks* untuk WhatsApp
  let formatted = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  // 2. Pastikan tidak ada lebih dari 2 baris kosong berturut-turut
  formatted = formatted.replace(/\n{3,}/g, "\n\n").trim();
  return formatted;
}
 

// Helper deteksi sapaan/salam murni
function isGreetingMessage(text) {
  if (!text) return false;

  const q = text.toLowerCase().trim();

  const greetings = [
    "halo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test",
    "pagi", "selamat pagi", "siang", "selamat siang",
    "sore", "selamat sore", "malam", "selamat malam",
    "assalamualaikum", "assalamu'alaikum",
    "assalamu alaikum", "permisi", "sampurasun"
  ];

  if (greetings.includes(q)) return true;

  if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum|permisi)\b/i.test(q)) {
    const productKeywords = [
      "produk", "harga", "katalog", "jual", "beli",
      "skincare", "sunscreen", "serum", "moisturizer",
      "shampoo", "conditioner", "pantene", "hada labo",
      "pepsodent", "watsons", "face wash", "cream"
    ];

    return !productKeywords.some(pk => q.includes(pk));
  }

  return false;
}

// Helper deteksi ucapan terima kasih
function isGratitudeMessage(text) {
  if (!text) return false;

  const q = text.toLowerCase().trim();

  const gratitudeList = [
    "terima kasih", "terimakasih", "makasih", "makasi",
    "thx", "thanks", "thank you", "matur nuwun",
    "nuhun", "syukron", "terima kasih banyak",
    "terimakasih banyak", "makasih banyak"
  ];

  if (gratitudeList.includes(q)) return true;

  return /^(terima\s+kasih|makasih|makasi|thanks|thank\s+you|thx|matur\s+nuwun|nuhun|syukron)\b/i.test(q);
}

// Logika Respons AI & Basis Pengetahuan dengan Conversation History
async function getAIResponse(senderId, message) {
  const normalized = message.toLowerCase().trim();

  // 1. Respons sapaan Glowberry
  if (isGreetingMessage(normalized)) {
    const greetingReply =
      "Hai Kak! Selamat datang di *Glowberry*! 💗\n\nAda yang bisa aku bantu cari hari ini? ✨";

    if (senderId) appendUserHistory(senderId, message, greetingReply);
    return greetingReply;
  }

  // 2. Respons ucapan terima kasih
  if (isGratitudeMessage(normalized)) {
    const gratitudeReply =
      "Sama-sama, Kak! 💗 Senang bisa membantu. Jangan ragu mampir lagi ke Glowberry ya! ✨";

    if (senderId) appendUserHistory(senderId, message, gratitudeReply);
    return gratitudeReply;
  }

  // 3. Ambil riwayat percakapan
  const history = senderId ? getUserHistory(senderId) : [];

  // 4. Ambil konteks produk dari RAG Watsons
  let ragContext = ragEngine.buildContext(message);

  // Mendukung pertanyaan lanjutan seperti "berapa harganya?"
  if (!ragContext && history.length > 0) {
    const previousQueries = history
      .filter(h => h.role === "user")
      .slice(-2)
      .map(h => h.content)
      .join(" ");

    ragContext = ragEngine.buildContext(
      `${previousQueries} ${message}`
    );
  }

  // 5. Inisialisasi Groq
  try {
    if (!groq) {
      if (
        process.env.GROQ_API_KEY &&
        process.env.GROQ_API_KEY !== "isi_api_key_groq"
      ) {
        groq = new Groq({
          apiKey: process.env.GROQ_API_KEY
        });
      } else {
        return "Maaf Kak, layanan Glowberry sedang offline karena API Groq belum dikonfigurasi. Silakan coba kembali nanti ya! 💗";
      }
    }

    // 6. System prompt khusus Watsons
    const systemPrompt = `
Anda adalah Glowberry, asisten belanja online yang ramah,
ceria, informatif, dan menyenangkan.

Anda membantu pelanggan mencari produk dari lapak Watsons
di Shopee berdasarkan katalog produk yang tersedia.

GAYA KOMUNIKASI:
- Gunakan Bahasa Indonesia yang natural dan santai.
- Panggil pelanggan dengan sapaan Kak.
- Bersikap ramah, hangat, dan tidak kaku.
- Gunakan emoji secukupnya seperti 💗, ✨, dan 🌷.
- Jawab secara jelas dan tidak bertele-tele.

IDENTITAS:
- Nama chatbot adalah Glowberry.
- Jangan pernah menyebut Aura Jewelry atau toko perhiasan.
- Jangan mengaku sebagai konsultan emas atau berlian.

ATURAN DATA PRODUK:
1. Jawab pertanyaan produk berdasarkan konteks katalog.
2. Jangan mengarang nama produk, harga, ukuran, varian,
   kandungan, manfaat, maupun spesifikasi.
3. Jangan mencampurkan informasi antarproduk.
4. Gunakan harga yang tercantum dalam konteks katalog.
5. Jika informasi tidak tersedia, katakan dengan jujur.
6. Jangan membuat klaim medis atau menjamin hasil skincare.
7. Jangan mengarang stok, promo, atau diskon.
8. Jangan menganggap semua produk merupakan skincare.
   Katalog juga dapat berisi produk kesehatan,
   perawatan rambut, tubuh, dan kebutuhan sehari-hari.

ATURAN PENCARIAN:
1. Jika pelanggan menyebut nama merek, cari produk
   yang sesuai dengan merek tersebut.
2. Jika pelanggan bertanya harga, gunakan data katalog.
3. Jika pelanggan bertanya produk termurah,
   gunakan produk dengan harga terendah dalam konteks.
4. Jika pelanggan meminta rekomendasi,
   sesuaikan dengan kebutuhan yang disebutkan.
5. Jika produk tidak ditemukan, sampaikan dengan sopan.
6. Jangan merekomendasikan produk yang tidak ada
   dalam konteks katalog.

ATURAN LINK SHOPEE:
1. Gunakan URL Shopee persis seperti yang tersedia.
2. Jangan membuat URL sendiri.
3. Jangan menukar link antarproduk.
4. Sertakan link pembelian jika diminta pelanggan.

FORMAT JAWABAN:
Untuk satu produk:

✨ Nama Produk
💰 Harga: Rp...
🛒 Link Shopee: URL produk

Untuk beberapa produk, gunakan bullet point
dan pisahkan setiap produk agar mudah dibaca.

ATURAN SALAM:
Jika pelanggan hanya menyapa, berikan salam ramah.
Jangan menampilkan katalog saat pelanggan hanya menyapa.

ATURAN INFORMASI:
Jangan mengarang alamat, nomor telepon,
jam operasional, atau informasi toko lainnya.
Jangan mengungkap API key maupun informasi internal sistem.

KONTEKS KATALOG PRODUK WATSONS:
${ragContext || "Tidak ditemukan produk yang cocok dalam katalog. Jangan mengarang informasi produk."}
`;

    // 7. Susun pesan untuk Groq
    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    // 8. Model utama dan alternatif
    const candidateModels = [
      process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "allam-2-7b"
    ];

    let lastError = null;

    for (const modelName of candidateModels) {
      try {
        const { data: completion, response } =
          await groq.chat.completions.create({
            model: modelName,
            messages: messagesPayload,
            max_tokens: Number(
              process.env.GROQ_MAX_TOKENS || 1500
            )
          }).withResponse();

        if (response && response.headers) {
          updateGroqQuotaFromHeaders(
            response.headers,
            modelName
          );
        }

        if (
          completion.choices &&
          completion.choices[0] &&
          completion.choices[0].message
        ) {
          const rawAiReply =
            completion.choices[0].message.content || "";

          const aiReply = formatWhatsAppMessage(rawAiReply);

          if (senderId) {
            appendUserHistory(senderId, message, aiReply);
          }

          return aiReply;
        }
      } catch (err) {
        lastError = err;

        console.warn(
          `[Groq Model ${modelName}] Gagal: ${err.message}. Mencoba model alternatif...`
        );
      }
    }

    throw lastError || new Error("Semua model Groq gagal merespons.");

  } catch (error) {
    console.error("Error Groq API:", error.message || error);

    // 9. Fallback jika Groq gagal tetapi RAG menemukan produk
    if (ragContext) {
      return formatWhatsAppMessage(
        `Hai Kak! 💗 Berikut informasi produk yang aku temukan:\n\n${ragContext}\n\nAda yang ingin Kakak tanyakan lagi? ✨`
      );
    }

    return formatWhatsAppMessage(
      "Hai Kak! 💗 Terima kasih sudah menghubungi Glowberry. Saat ini layanan chatbot sedang mengalami gangguan sementara. Silakan coba kembali beberapa saat lagi ya! ✨"
    );
  }
}

// Helper Masking Nomor Telepon (Format: 08xxxxxx4digit)
function maskPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let formatted = String(rawNumber).replace(/^62/, "08");
  if (formatted.length >= 8) {
    const prefix = formatted.slice(0, 2); // "08"
    const suffix = formatted.slice(-4);   // 4 digit terakhir
    const maskedLength = formatted.length - 6;
    return `${prefix}${"x".repeat(maskedLength)}${suffix}`;
  }
  return formatted;
}
 
// ================= API ENDPOINTS =================
 
// Status Bot
app.get("/api/bot/status", (req, res) => {
  let botNumber = null;
  if (isReady && client && client.info && client.info.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }
 
  res.json({
    isReady,
    isInitializing,
    isCleaning,
    hasQRCode: Boolean(qrCodeData),
    botNumber
  });
});
 
// Kuota & Rate Limit Groq AI
app.get("/api/groq/quota", async (req, res) => {
  try {
    const isFresh = req.query.fresh === "true" || groqQuota.remainingRequests === null;
    if (isFresh) {
      await fetchGroqQuotaFresh();
    }
    res.json(groqQuota);
  } catch (err) {
    console.error("Error cek kuota Groq:", err);
    res.status(500).json({ error: err.message, ...groqQuota });
  }
});
 

 // API Chatbot untuk Website Glowberry
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "Pesan tidak boleh kosong."
      });
    }

    console.log(`[Glowberry Website] Pertanyaan: ${message}`);

    const reply = await getAIResponse(null, message.trim());

    console.log(`[Glowberry Website] Jawaban: ${reply}`);

    return res.json({
      success: true,
      reply
    });

  } catch (error) {
    console.error("Chat API Error:", error);

    return res.status(500).json({
      success: false,
      error: "Maaf, Glowberry sedang mengalami gangguan."
    });
  }
});

// QR Code Data
app.get("/api/bot/qr", (req, res) => {
  res.json({ qr: qrCodeData });
});
 
// Start Bot
app.post("/api/bot/start", async (req, res) => {
  try {
    if (isReady) {
      return res.json({ success: true, message: "Bot sudah berjalan." });
    }
    if (isInitializing) {
      return res.json({ success: true, message: "Bot sedang proses inisialisasi..." });
    }
 
    isInitializing = true;
    const waClient = initializeClient();
    await waClient.initialize();
    res.json({ success: true });
  } catch (err) {
    isInitializing = false;
    console.error("Gagal memulai bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
 
// Stop Bot
app.post("/api/bot/stop", async (req, res) => {
  try {
    isCleaning = true;
    isReady = false;
    qrCodeData = null;
    if (client) {
      await client.destroy();
    }
    client = null;
    isCleaning = false;
    res.json({ success: true });
  } catch (err) {
    isCleaning = false;
    console.error("Gagal menghentikan bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
 
// Reset Sesi WhatsApp (Hapus sesi yang nyangkut / logout)
app.post("/api/bot/reset", async (req, res) => {
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
 
    const authDir = path.join(__dirname, ".wwebjs_auth");
    const cacheDir = path.join(__dirname, ".wwebjs_cache");
 
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log("[Reset Session]: Folder .wwebjs_auth berhasil dihapus");
    }
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log("[Reset Session]: Folder .wwebjs_cache berhasil dihapus");
    }
 
    conversationHistory.clear();
    console.log("[Reset Session]: Seluruh riwayat obrolan berhasil dibersihkan");
 
    isCleaning = false;
    res.json({ success: true, message: "Sesi WhatsApp berhasil dibersihkan. Anda dapat memindai QR baru." });
  } catch (err) {
    isCleaning = false;
    console.error("Gagal mereset sesi bot:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
 
// Ambil data Basis Pengetahuan
app.get("/api/knowledge", (req, res) => {
  loadKnowledge();
  res.json(knowledge);
});
 
// Ambil daftar produk CSV
app.get("/api/products", (req, res) => {
  ragEngine.loadData();
  res.json({ products: ragEngine.products });
});
 
// Jalankan Server
const server = app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  if (process.env.AUTO_START_BOT === "true") {
    console.log("AUTO_START_BOT aktif, memulai inisialisasi bot WhatsApp...");
    isInitializing = true;
    const waClient = initializeClient();
    waClient.initialize().catch(err => {
      isInitializing = false;
      console.error("Auto start gagal:", err);
    });
  }
});
 
// Penutupan bersih saat server dihentikan (mencegah Chrome nyangkut)
async function gracefulShutdown(signal) {
  console.log(`\nMenerima sinyal ${signal}, membersihkan proses...`);
  if (client) {
    try {
      await client.destroy();
      console.log("Koneksi WhatsApp & browser Chrome berhasil ditutup.");
    } catch (e) {
      // Abaikan jika sudah tertutup
    }
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}
 
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));