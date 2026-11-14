const fs = require("fs");
const path = require("path");

/**
 * Aturan kategori berbasis nama produk.
 * Kolom "kategori" pada CSV hasil scraping Shopee kosong, sehingga kategori
 * diturunkan secara deterministik dari nama produk. Urutan aturan penting:
 * aturan pertama yang cocok akan dipakai (mis. "UV Whitening Milk SPF" harus
 * masuk Tabir Surya, bukan Perawatan Wajah).
 *
 * `tags` adalah sinonim yang ikut diindeks agar pertanyaan seperti
 * "skincare", "sabun muka", atau "rambut rontok" bisa menemukan produk.
 */
const CATEGORY_RULES = [
  {
    name: "Tabir Surya",
    pattern: /\b(spf|sunscreen|sun\s*battle|uv)\b/i,
    tags: "tabir surya sunscreen sunblock spf uv perawatan wajah skincare kulit"
  },
  {
    name: "Perawatan Rambut",
    pattern: /\b(shampoo|sampo|conditioner|hair)\b/i,
    tags: "perawatan rambut haircare rambut rontok keramas shampoo sampo conditioner"
  },
  {
    name: "Perawatan Mulut",
    pattern: /\b(pepsodent|listerine|pasta gigi|toothpaste|mouthwash|obat kumur)\b/i,
    tags: "perawatan mulut gigi pasta gigi odol obat kumur mouthwash napas"
  },
  {
    name: "Kewanitaan",
    pattern: /\b(softex|pantyliner|pembalut)\b/i,
    tags: "kewanitaan pantyliner pembalut wanita feminine"
  },
  {
    name: "Kesehatan",
    pattern: /\b(vicee|vitamin c tablet|tablet|suplemen)\b/i,
    tags: "kesehatan vitamin suplemen daya tahan tubuh"
  },
  {
    name: "Perawatan Tubuh",
    pattern: /\b(sabun mandi|body wash|lulur|vaseline|body|powder|deodoran)\b/i,
    tags: "perawatan tubuh bodycare badan kulit tubuh sabun mandi lulur body lotion bedak"
  },
  {
    name: "Perawatan Wajah",
    pattern: /\b(face|wajah|cleanser|moisturi[sz]er|moisturi[sz]ing|serum|lotion|cream|krim|balm|baume|toner|gel|skin)\b/i,
    tags: "perawatan wajah skincare muka kulit wajah pelembab sabun muka pembersih wajah facial"
  }
];

const DEFAULT_CATEGORY = "Lainnya";

const STOP_WORDS = new Set([
  "yang", "dan", "atau", "untuk", "dengan", "apa", "apakah", "berapa",
  "tolong", "dong", "saya", "aku", "kak", "mau", "ingin", "ada", "produk",
  "produknya", "watsons", "jual", "tampilkan", "cari", "kasih", "lihat",
  "daftar", "saja", "aja", "harga", "harganya", "brp", "rekomendasi",
  "rekomendasikan", "rekomen", "rekom", "sarankan", "saran", "bagus", "yg",
  "nya", "itu", "ini", "punya", "kalian", "toko", "glowberry", "boleh",
  "bisa", "minta", "info", "tentang", "mana", "berikan", "sebutkan",
  "the", "and", "for", "beli", "membeli"
]);

class RAGEngine {
  constructor(csvPath, options = {}) {
    this.csvPath = csvPath || path.join(__dirname, "../data/products.csv");
    this.topK = options.topK || Number(process.env.RAG_TOP_K || 8);
    this.products = [];
    this.loadedMtime = null;
    this.loadData();
  }

  // Membaca CSV dengan dukungan tanda kutip dan koma dalam teks
  parseCSV(content) {
    const rows = [];
    let row = [];
    let field = "";
    let insideQuotes = false;

    content = content.replace(/^﻿/, "");

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const next = content[i + 1];

      if (char === '"' && insideQuotes && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !insideQuotes) {
        if (char === "\r" && next === "\n") i++;

        row.push(field);

        if (row.some(value => value.trim() !== "")) {
          rows.push(row);
        }

        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    if (field || row.length) {
      row.push(field);
      if (row.some(value => value.trim() !== "")) rows.push(row);
    }

    if (rows.length < 2) return [];

    const headers = rows.shift().map(header => header.trim().toLowerCase());

    return rows.map(columns => {
      const result = {};

      headers.forEach((header, index) => {
        result[header] = (columns[index] || "").trim();
      });

      return result;
    });
  }

  // Mengubah harga Indonesia ("13.000", "Rp 1.500") menjadi angka
  parsePrice(value) {
    if (!value) return 0;

    const cleaned = String(value)
      .replace(/rp/gi, "")
      .replace(/\s/g, "")
      .replace(/\./g, "")
      .replace(/,/g, "");

    return Number(cleaned) || 0;
  }

  formatCurrency(value) {
    const number = this.parsePrice(value);

    if (!number) return "Harga belum tersedia";

    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0
    }).format(number);
  }

  // Menentukan kategori dari nama produk bila kolom kategori kosong
  inferCategory(name) {
    const rule = CATEGORY_RULES.find(item => item.pattern.test(name || ""));
    return rule ? rule.name : DEFAULT_CATEGORY;
  }

  categoryTags(category) {
    const rule = CATEGORY_RULES.find(item => item.name === category);
    return rule ? rule.tags : "";
  }

  // Memuat data produk Watsons (di-cache sampai file CSV berubah)
  loadData() {
    try {
      if (!fs.existsSync(this.csvPath)) {
        console.warn("[RAG] File CSV tidak ditemukan:", this.csvPath);
        this.products = [];
        this.loadedMtime = null;
        return this.products;
      }

      const mtime = fs.statSync(this.csvPath).mtimeMs;
      if (this.loadedMtime === mtime && this.products.length) {
        return this.products;
      }

      const content = fs.readFileSync(this.csvPath, "utf8");
      const rows = this.parseCSV(content);

      this.products = rows
        .map((row, index) => {
          const nama = row.nama || row["nama produk"] || "";
          const kategori = row.kategori || this.inferCategory(nama);

          return {
            id: index + 1,
            nama,
            kategori,
            harga: row.harga || "",
            hargaAngka: this.parsePrice(row.harga),
            deskripsi: row.deskripsi || "",
            gambar: row.gambar || "",
            href: row["contents href"] || row.link || row.href || ""
          };
        })
        .filter(product => product.nama);

      this.loadedMtime = mtime;

      console.log(
        `[RAG] Berhasil memuat ${this.products.length} produk Watsons dari CSV ` +
        `(${this.products.filter(p => p.href).length} dengan link Shopee)`
      );
    } catch (error) {
      console.error("[RAG] Gagal memuat CSV:", error);
      this.products = [];
      this.loadedMtime = null;
    }

    return this.products;
  }

  getCategories() {
    return [...new Set(this.products.map(p => p.kategori).filter(Boolean))];
  }

  // Mendeteksi sapaan
  isGreetingQuery(query) {
    const q = query.toLowerCase().trim();

    return [
      "halo", "hai", "hi", "hey", "hello",
      "pagi", "selamat pagi",
      "siang", "selamat siang",
      "sore", "selamat sore",
      "malam", "selamat malam",
      "assalamualaikum", "permisi"
    ].includes(q);
  }

  // Mendeteksi permintaan seluruh katalog
  isAllProductsQuery(query) {
    const q = query.toLowerCase().trim().replace(/[?!.]+$/g, "").trim();

    const patterns = [
      /^semua(\s+produk(nya)?)?$/,
      /^(ada\s+)?produk\s+(apa|ada)\s+(aja|saja)$/,
      /^apa\s+(aja|saja)\s+produk(nya)?$/,
      /^katalog(\s+produk|\s+lengkap)?$/,
      /^(lihat\s+|tampilkan\s+)?daftar\s+produk$/,
      /^list\s+produk$/,
      /^koleksi(\s+lengkap)?$/,
      /^semuanya$/,
      /^(tampilkan|lihat)\s+semua\s+produk$/
    ];

    return patterns.some(pattern => pattern.test(q));
  }

  tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  // Mencari produk berdasarkan pertanyaan
  search(query, k = this.topK) {
    if (!query) return [];

    this.loadData();
    if (this.products.length === 0) return [];

    const normalized = query.toLowerCase().trim();

    if (this.isGreetingQuery(normalized)) return [];

    if (this.isAllProductsQuery(normalized)) return this.products;

    const sortByPrice = direction => list =>
      [...list]
        .filter(p => p.hargaAngka > 0)
        .sort((a, b) => direction * (a.hargaAngka - b.hargaAngka));

    const wantsCheapest = /termurah|paling murah|harga terendah|murah/.test(normalized);
    const wantsPriciest = !wantsCheapest && /termahal|paling mahal|harga tertinggi|\bmahal\b/.test(normalized);
    // Catatan: jangan langsung mengurutkan seluruh katalog di sini. Filter merek/kategori
    // dijalankan dulu di bawah; pengurutan harga (numerik, hargaAngka) dilakukan setelahnya.
    // Seluruh katalog hanya dipakai bila tidak ada kata kunci spesifik ("Apa produk termurah?").

    const keywords = this.tokenize(normalized).filter(
      token =>
        (token.length > 2 || /\d/.test(token)) &&
        !STOP_WORDS.has(token) &&
        !["termurah", "murah", "paling", "termahal", "mahal", "terendah", "tertinggi"].includes(token)
    );

    const scored = this.products.map(product => {
      const nameTokens = this.tokenize(product.nama);
      const nameText = product.nama.toLowerCase();
      const categoryText = product.kategori.toLowerCase();
      const tagText = this.categoryTags(product.kategori);
      const descText = product.deskripsi.toLowerCase();

      let score = 0;

      for (const keyword of keywords) {
        if (nameTokens.includes(keyword)) score += 10;
        else if (nameText.includes(keyword)) score += 6;

        if (categoryText.includes(keyword)) score += 5;
        if (tagText.includes(keyword)) score += 6;
        if (descText.includes(keyword)) score += 2;
      }

      // Bonus bila seluruh frasa merek muncul berurutan (mis. "hada labo")
      if (keywords.length > 1 && nameText.includes(keywords.join(" "))) {
        score += 10;
      }

      return { product, score };
    });

    let results;

    if (keywords.length === 0) {
      // Tanpa kata kunci spesifik, hanya pertanyaan harga yang dijawab
      if (!wantsCheapest && !wantsPriciest) return [];
      results = this.products;
    } else {
      const matches = scored.filter(item => item.score > 0);
      if (matches.length === 0) return [];

      const best = Math.max(...matches.map(item => item.score));
      // Buang hasil yang skornya jauh di bawah hasil terbaik agar konteks fokus
      results = matches
        .filter(item => item.score >= best * 0.35)
        .sort((a, b) => b.score - a.score)
        .map(item => item.product);
    }

    if (wantsCheapest) results = sortByPrice(1)(results);
    else if (wantsPriciest) results = sortByPrice(-1)(results);

    return results.slice(0, k);
  }

  // Menyusun konteks produk untuk Groq
  buildContext(query) {
    const relevantProducts = this.search(query);

    if (!relevantProducts.length) return "";

    return this.formatProducts(relevantProducts);
  }

  formatProducts(products) {
    let output = "KATALOG PRODUK WATSONS SHOPEE\n";
    output += `Menampilkan ${products.length} produk paling relevan dari total ${this.products.length} produk di katalog.\n`;

    products.forEach((product, index) => {
      output += `\nProduk ${index + 1}\n`;
      output += `Nama: ${product.nama}\n`;
      output += `Kategori: ${product.kategori}\n`;
      output += `Harga: ${this.formatCurrency(product.harga)}\n`;
      if (product.deskripsi) output += `Deskripsi: ${product.deskripsi}\n`;
      output += `Link Shopee: ${product.href || "Tidak tersedia"}\n`;
    });

    return output.trim();
  }
}

RAGEngine.CATEGORY_RULES = CATEGORY_RULES;

module.exports = RAGEngine;
