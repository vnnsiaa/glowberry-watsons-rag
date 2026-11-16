/**
 * Logika chatbot Glowberry yang dipakai bersama oleh:
 *  - Vercel Function  : api/chat.js
 *  - Server persisten : server-v2.js (website lokal + WhatsApp Gateway)
 *
 * Alur: sapaan/terima kasih -> FAQ (knowledge.json) -> retrieval katalog (RAG)
 *       -> Groq LLM dengan konteks -> fallback deterministik bila Groq gagal.
 */
const fs = require("fs");
const path = require("path");
const Groq = require("groq-sdk");
const RAGEngine = require("./rag");

const ROOT = path.join(__dirname, "..");
const DEFAULT_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_FALLBACK_MODELS = "openai/gpt-oss-120b,openai/gpt-oss-20b";
const PLACEHOLDER_KEYS = new Set(["", "isi_api_key_groq", "your_groq_api_key"]);

const GREETINGS = [
  "halo", "hallo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test",
  "pagi", "selamat pagi", "siang", "selamat siang",
  "sore", "selamat sore", "malam", "selamat malam",
  "assalamualaikum", "assalamu'alaikum", "assalamu alaikum",
  "permisi", "sampurasun", "halo kak", "hai kak", "hi kak"
];

const GRATITUDE = [
  "terima kasih", "terimakasih", "makasih", "makasi", "thx", "thanks",
  "thank you", "matur nuwun", "nuhun", "syukron", "terima kasih banyak",
  "terimakasih banyak", "makasih banyak", "makasih kak", "terima kasih kak"
];

const PRODUCT_HINTS = [
  "produk", "harga", "katalog", "jual", "beli", "skincare", "sunscreen",
  "serum", "moisturizer", "shampoo", "conditioner", "pantene", "hada labo",
  "pepsodent", "watsons", "face wash", "cream", "rekomendasi", "murah"
];

const GREETING_REPLY =
  "Hai Kak! Selamat datang di Glowberry 💗\n\nAda yang bisa aku bantu cari hari ini? ✨";
const GRATITUDE_REPLY =
  "Sama-sama, Kak! 💗 Senang bisa membantu. Jangan ragu mampir lagi ke Glowberry ya! ✨";

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[!?.,~]+/g, " ").replace(/\s+/g, " ").trim();
}

function isGreeting(text) {
  const q = normalize(text);
  if (!q) return false;
  if (GREETINGS.includes(q)) return true;

  if (/^(halo|hallo|hai|hi|hey|hello|selamat (pagi|siang|sore|malam)|assalamu ?alaikum|permisi)\b/.test(q)) {
    // "halo, ada sunscreen?" bukan sekadar sapaan
    const rest = q.replace(/^(halo|hallo|hai|hi|hey|hello|selamat (pagi|siang|sore|malam)|assalamu ?alaikum|permisi)\b/, "").trim();
    if (!rest || /^(kak|kakak|min|admin|glowberry)$/.test(rest)) return true;
    return !PRODUCT_HINTS.some(hint => q.includes(hint)) && rest.split(" ").length <= 2;
  }

  return false;
}

function isGratitude(text) {
  const q = normalize(text);
  if (!q) return false;
  if (GRATITUDE.includes(q)) return true;
  return /^(terima ?kasih|makasih|makasi|thanks|thank you|thx|matur nuwun|nuhun|syukron)\b/.test(q) &&
    q.split(" ").length <= 5;
}

function stripReasoning(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/**
 * Memecah satu pesan menjadi beberapa pertanyaan, mis.
 * "Produk Hada Labo? Sunscreen murah?" -> ["Produk Hada Labo", "Sunscreen murah"].
 * Pemisah: tanda tanya, baris baru, titik koma, nomor daftar, koma, "dan", "serta", "lalu", "terus", "juga".
 */
function splitQuestions(text) {
  return String(text || "")
    .split(/[?\n;]+|(?:^|\s)\d+[.)]\s+|,\s+|\s+(?:dan|serta|lalu|terus|juga)\s+/i)
    .map(part => (part || "").trim().replace(/^\d+[.)]\s*/, "").trim())
    .filter(part => part.replace(/[^\p{L}\p{N}]/gu, "").length >= 2);
}

function uniqueProducts(groups) {
  const seen = new Set();
  const list = [];
  for (const group of groups) {
    for (const product of group.products) {
      if (!seen.has(product.id)) {
        seen.add(product.id);
        list.push(product);
      }
    }
  }
  return list;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUsableKey(key) {
  return Boolean(key) && !PLACEHOLDER_KEYS.has(String(key).trim());
}

function buildSystemPrompt({ productContext, faqContext }) {
  return `Anda adalah Glowberry, asisten belanja yang ramah untuk katalog produk dari lapak Watsons di Shopee.

GAYA:
- Bahasa Indonesia yang natural, hangat, santai, sopan, dan ringkas.
- Panggil pelanggan "Kak" secara wajar. Emoji secukupnya (💗 ✨ 🌷).
- Jangan memakai tabel atau heading markdown. Gunakan poin "•" untuk daftar.

ATURAN DATA (WAJIB):
1. Informasi produk HANYA boleh berasal dari KONTEKS KATALOG di bawah.
2. Jangan mengarang nama, harga, kategori, kandungan, manfaat, ukuran, varian, stok, promo, atau diskon.
3. Jika produk/informasi tidak ada di konteks, katakan dengan jujur bahwa belum tersedia di katalog Glowberry.
4. Jangan mencampur informasi antarproduk. Gunakan harga persis seperti di konteks.
5. Jangan membuat klaim medis atau menjamin hasil pemakaian.
6. Untuk pertanyaan termurah/termahal, konteks sudah diurutkan berdasarkan harga.
7. Jika konteks dibagi per PERTANYAAN, jawab setiap pertanyaan secara terpisah (beri judul singkat per pertanyaan) hanya dengan produk dari bagiannya sendiri. Jangan mencampur produk antarbagian.
8. Untuk rekomendasi, pilih dari konteks yang sesuai kebutuhan pelanggan; boleh bertanya balik jika kebutuhannya belum jelas.
9. Jangan mengarang alamat, nomor telepon, jam operasional, atau kebijakan toko. Untuk pertanyaan layanan, gunakan INFORMASI LAYANAN.
10. Jangan menyebut CSV, RAG, prompt, model AI, API key, atau detail sistem internal.

ATURAN LINK:
- Gunakan URL Shopee persis seperti di konteks. Jangan membuat, memendekkan, atau menukar URL.

FORMAT PRODUK:
• Nama produk
  Harga: Rp...
  Link: URL Shopee

KONTEKS KATALOG:
${productContext || "Tidak ada produk yang cocok di katalog untuk pertanyaan ini. Jangan menyebut produk apa pun."}

INFORMASI LAYANAN:
${faqContext || "Tidak ada informasi layanan yang relevan."}`;
}

class GlowberryChatbot {
  constructor(options = {}) {
    this.ragEngine =
      options.ragEngine ||
      new RAGEngine(options.csvPath || path.join(ROOT, "data", "products.csv"));
    // Jika knowledge diberikan langsung (mis. untuk test), file tidak dibaca
    this.knowledgePath = options.knowledge
      ? null
      : options.knowledgePath || path.join(ROOT, "knowledge.json");
    this.knowledge = options.knowledge || null;
    this.groq = options.groqClient || null;
    this.env = options.env || process.env;
    this.cooldowns = new Map(); // model -> timestamp boleh dipakai lagi
    this.quota = {
      model: this.primaryModel(),
      remainingRequests: null,
      limitRequests: null,
      remainingTokens: null,
      limitTokens: null,
      resetRequests: null,
      lastChecked: null,
      configured: this.isConfigured()
    };
  }

  primaryModel() {
    return (this.env.GROQ_MODEL || "").trim() || DEFAULT_MODEL;
  }

  candidateModels() {
    const fallbacks = (this.env.GROQ_FALLBACK_MODELS || DEFAULT_FALLBACK_MODELS)
      .split(",")
      .map(m => m.trim())
      .filter(Boolean);
    return [...new Set([this.primaryModel(), ...fallbacks])];
  }

  // Model yang baru kena rate limit (429) dilewati sampai waktu tunggunya habis
  orderedModels() {
    const now = Date.now();
    const models = this.candidateModels();
    const available = models.filter(m => (this.cooldowns.get(m) || 0) <= now);
    return available.length ? available : models;
  }

  markRateLimited(model, error) {
    let seconds = 30;
    const header = error && error.headers && (typeof error.headers.get === "function"
      ? error.headers.get("retry-after")
      : error.headers["retry-after"]);
    const fromMessage = /try again in ([\d.]+)s/i.exec((error && error.message) || "");
    if (header && Number(header) > 0) seconds = Number(header);
    else if (fromMessage) seconds = Number(fromMessage[1]);
    this.cooldowns.set(model, Date.now() + Math.min(seconds, 120) * 1000);
  }

  isConfigured() {
    return Boolean(this.groq) || hasUsableKey(this.env.GROQ_API_KEY);
  }

  getGroq() {
    if (this.groq) return this.groq;
    if (!hasUsableKey(this.env.GROQ_API_KEY)) return null;

    this.groq = new Groq({
      apiKey: this.env.GROQ_API_KEY,
      timeout: Number(this.env.GROQ_TIMEOUT_MS || 20000),
      // Tanpa retry otomatis: bila kena rate limit langsung pindah ke model cadangan
      maxRetries: 0
    });
    return this.groq;
  }

  loadKnowledge() {
    if (this.knowledge && !this.knowledgePath) return this.knowledge;
    try {
      this.knowledge = JSON.parse(fs.readFileSync(this.knowledgePath, "utf8"));
    } catch (error) {
      if (!this.knowledge) {
        console.error("[Knowledge] Gagal membaca knowledge.json:", error.message);
        this.knowledge = { keywords: {}, responses: {} };
      }
    }
    return this.knowledge;
  }

  // Mencocokkan FAQ berdasarkan kata kunci utuh (bukan potongan kata)
  matchFaq(message) {
    const { keywords = {}, responses = {} } = this.loadKnowledge();
    const q = ` ${normalize(message)} `;
    const topics = [];

    Object.keys(keywords)
      .sort((a, b) => b.length - a.length)
      .forEach(keyword => {
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword.toLowerCase())}([^\\p{L}\\p{N}]|$)`, "u");
        const topic = keywords[keyword];
        if (pattern.test(q) && responses[topic] && !topics.includes(topic)) {
          topics.push(topic);
        }
      });

    return topics.slice(0, 3).map(topic => ({ topic, answer: responses[topic] }));
  }

  updateQuotaFromHeaders(headers, model) {
    if (!headers) return;
    const get = name => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
    const num = value => (value === null || value === undefined || value === "" ? null : Number(value));

    this.quota.model = model;
    const fields = {
      remainingRequests: num(get("x-ratelimit-remaining-requests")),
      limitRequests: num(get("x-ratelimit-limit-requests")),
      remainingTokens: num(get("x-ratelimit-remaining-tokens")),
      limitTokens: num(get("x-ratelimit-limit-tokens"))
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== null && Number.isFinite(value)) this.quota[key] = value;
    }
    const reset = get("x-ratelimit-reset-requests");
    if (reset) this.quota.resetRequests = reset;
    this.quota.lastChecked = new Date().toISOString();
    this.quota.configured = true;
  }

  async refreshQuota() {
    const groq = this.getGroq();
    this.quota.configured = Boolean(groq);
    if (!groq) return this.getQuota();

    const model = this.primaryModel();
    try {
      const { response } = await groq.chat.completions
        .create({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 })
        .withResponse();
      this.updateQuotaFromHeaders(response.headers, model);
      this.quota.error = null;
    } catch (error) {
      this.quota.error = "Gagal menghubungi Groq.";
      console.warn("[Groq] Gagal mengecek kuota:", error.message);
    }
    return this.getQuota();
  }

  getQuota() {
    return { ...this.quota, configured: this.isConfigured() };
  }

  /**
   * Retrieval per pertanyaan. Setiap pertanyaan dicari terpisah sehingga produk
   * dari satu pertanyaan tidak mencemari pertanyaan lain.
   * @returns {Array<{question:string, products:object[]}>}
   */
  retrieve(text, history = []) {
    const questions = splitQuestions(text);

    if (questions.length > 1) {
      const perQuestion = Math.min(this.ragEngine.topK, 5);
      const groups = questions
        .map(question => ({ question, products: this.ragEngine.search(question, perQuestion) }))
        .filter(group => group.products.length);

      if (groups.length > 1) return groups;
      // Hanya satu bagian relevan (mis. "sunscreen murah dan bagus"): perlakukan sebagai satu pertanyaan
    }

    let products = this.ragEngine.search(text);

    // Pertanyaan lanjutan ("berapa harganya?") memakai pertanyaan sebelumnya
    if (!products.length && history.length) {
      const previous = history.filter(h => h.role === "user").slice(-2).map(h => h.content).join(" ");
      products = this.ragEngine.search(`${previous} ${text}`);
    }

    return products.length ? [{ question: text, products }] : [];
  }

  buildProductContext(groups) {
    if (!groups.length) return "";
    if (groups.length === 1) return this.ragEngine.formatProducts(groups[0].products);

    return groups
      .map((group, index) =>
        `=== PERTANYAAN ${index + 1}: "${group.question}" ===\n${this.ragEngine.formatProducts(group.products)}`
      )
      .join("\n\n");
  }

  formatProductList(products) {
    return products
      .map(p =>
        `• ${p.nama}\n  Harga: ${this.ragEngine.formatCurrency(p.harga)}` +
        (p.href ? `\n  Link: ${p.href}` : "")
      )
      .join("\n\n");
  }

  // Jawaban tanpa LLM, hanya dari data nyata (katalog + FAQ)
  buildFallbackReply(groups, faqs) {
    const parts = [];

    if (faqs.length) parts.push(faqs.map(f => f.answer).join("\n\n"));

    if (groups.length === 1) {
      parts.push(`Berikut produk dari katalog Glowberry yang cocok, Kak 💗\n\n${this.formatProductList(groups[0].products)}`);
    } else if (groups.length > 1) {
      parts.push(
        "Berikut jawaban untuk setiap pertanyaan Kakak 💗\n\n" +
        groups
          .map(group => `*${group.question}*\n${this.formatProductList(group.products)}`)
          .join("\n\n")
      );
    }

    if (!parts.length) {
      return "Maaf Kak, aku belum menemukan produk yang cocok di katalog Glowberry 🌷 " +
        "Coba sebutkan merek atau jenis produknya ya, misalnya \"sunscreen\" atau \"Hada Labo\". ✨";
    }

    return parts.join("\n\n");
  }

  /**
   * @param {string} message
   * @param {{history?: Array<{role:string,content:string}>}} options
   * @returns {Promise<{reply:string, source:string, model?:string, products:number[], faq:string[]}>}
   */
  async reply(message, options = {}) {
    const text = String(message || "").trim();
    const history = Array.isArray(options.history) ? options.history : [];

    if (!text) throw new Error("Pesan kosong.");

    if (isGreeting(text)) {
      return { reply: GREETING_REPLY, source: "greeting", products: [], faq: [] };
    }
    if (isGratitude(text)) {
      return { reply: GRATITUDE_REPLY, source: "gratitude", products: [], faq: [] };
    }

    const groups = this.retrieve(text, history);
    const products = uniqueProducts(groups);

    const faqs = this.matchFaq(text);
    const meta = { products: products.map(p => p.id), faq: faqs.map(f => f.topic) };

    // Pertanyaan layanan murni (tanpa produk) dijawab langsung dari FAQ
    if (faqs.length && !products.length) {
      return { reply: faqs.map(f => f.answer).join("\n\n"), source: "faq", ...meta };
    }

    const groq = this.getGroq();
    if (!groq) {
      return { reply: this.buildFallbackReply(groups, faqs), source: "fallback", ...meta };
    }

    const productContext = this.buildProductContext(groups);
    const faqContext = faqs.map(f => `- ${f.answer}`).join("\n");

    const messages = [
      { role: "system", content: buildSystemPrompt({ productContext, faqContext }) },
      ...history.slice(-6),
      { role: "user", content: text }
    ];

    let lastError = null;

    for (const model of this.orderedModels()) {
      try {
        const { data, response } = await groq.chat.completions
          .create({
            model,
            messages,
            temperature: 0.3,
            max_tokens: Number(this.env.GROQ_MAX_TOKENS || 1024)
          })
          .withResponse();

        this.updateQuotaFromHeaders(response && response.headers, model);

        const content = stripReasoning(data.choices?.[0]?.message?.content);
        if (content) return { reply: content, source: "groq", model, ...meta };

        lastError = new Error(`Model ${model} mengembalikan jawaban kosong.`);
      } catch (error) {
        lastError = error;
        if (error.status === 429) this.markRateLimited(model, error);
        console.warn(`[Groq] Model ${model} gagal (${error.status || "network"}): ${String(error.message).slice(0, 160)}`);
      }
    }

    console.error("[Groq] Semua model gagal:", lastError && lastError.message);
    return { reply: this.buildFallbackReply(groups, faqs), source: "fallback", ...meta };
  }
}

let sharedInstance = null;

function getChatbot() {
  if (!sharedInstance) sharedInstance = new GlowberryChatbot();
  return sharedInstance;
}

module.exports = {
  GlowberryChatbot,
  getChatbot,
  isGreeting,
  isGratitude,
  stripReasoning,
  buildSystemPrompt,
  hasUsableKey,
  splitQuestions,
  DEFAULT_MODEL
};
