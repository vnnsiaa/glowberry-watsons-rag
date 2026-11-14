
const fs = require("fs");
const path = require("path");

class RAGEngine {
  constructor(csvPath, options = {}) {
    this.csvPath = csvPath || path.join(__dirname, "../data/products.csv");
    this.topK = options.topK || Number(process.env.RAG_TOP_K || 8);
    this.products = [];
    this.loadData();
  }

  // Membaca CSV dengan dukungan tanda kutip dan koma dalam teks
  parseCSV(content) {
    const rows = [];
    let row = [];
    let field = "";
    let insideQuotes = false;

    content = content.replace(/^\uFEFF/, "");

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
      rows.push(row);
    }

    if (rows.length < 2) return [];

    const headers = rows.shift().map(header =>
      header.trim().toLowerCase()
    );

    return rows.map(columns => {
      const result = {};

      headers.forEach((header, index) => {
        result[header] = (columns[index] || "").trim();
      });

      return result;
    });
  }

  // Mengubah harga Indonesia menjadi angka
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

  // Memuat data produk Watsons
  loadData() {
    try {
      if (!fs.existsSync(this.csvPath)) {
        console.warn("[RAG] File CSV tidak ditemukan:", this.csvPath);
        this.products = [];
        return;
      }

      const content = fs.readFileSync(this.csvPath, "utf8");
      const rows = this.parseCSV(content);

      this.products = rows
        .map((row, index) => ({
          id: index + 1,
          nama: row.nama || row["nama produk"] || "",
          kategori: row.kategori || "Lainnya",
          harga: row.harga || "",
          deskripsi: row.deskripsi || "",
          gambar: row.gambar || "",
          href: row["contents href"] || ""
        }))
        .filter(product => product.nama);

      console.log(
        `[RAG] Berhasil memuat ${this.products.length} produk Watsons dari CSV`
      );

      console.log(
        `[RAG] Produk dengan link Shopee: ${
          this.products.filter(p => p.href).length
        }`
      );

    } catch (error) {
      console.error("[RAG] Gagal memuat CSV:", error);
      this.products = [];
    }
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
    const q = query.toLowerCase().trim();

    const patterns = [
      /^semua(\s+produk(nya)?)?$/,
      /^produk\s+(apa|ada)\s+(aja|saja)$/,
      /^apa\s+aja\s+produknya$/,
      /^katalog(\s+produk|\s+lengkap)?$/,
      /^daftar\s+produk$/,
      /^list\s+produk$/,
      /^koleksi(\s+lengkap)?$/,
      /^semuanya$/,
      /^tampilkan\s+semua\s+produk$/,
      /^lihat\s+semua\s+produk$/
    ];

    return patterns.some(pattern => pattern.test(q));
  }

  // Mencari produk berdasarkan pertanyaan
  search(query, k = this.topK) {
    if (!query || this.products.length === 0) return [];

    const normalized = query.toLowerCase().trim();

    if (this.isGreetingQuery(normalized)) {
      return [];
    }

    if (this.isAllProductsQuery(normalized)) {
      return this.products;
    }

    // Pencarian produk termurah
    if (/termurah|paling murah|harga terendah/.test(normalized)) {
      return [...this.products]
        .filter(p => this.parsePrice(p.harga) > 0)
        .sort((a, b) =>
          this.parsePrice(a.harga) - this.parsePrice(b.harga)
        )
        .slice(0, k);
    }

    // Pencarian produk termahal
    if (/termahal|paling mahal|harga tertinggi/.test(normalized)) {
      return [...this.products]
        .filter(p => this.parsePrice(p.harga) > 0)
        .sort((a, b) =>
          this.parsePrice(b.harga) - this.parsePrice(a.harga)
        )
        .slice(0, k);
    }

    const tokens = normalized
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(token => token.length > 2);

    const stopWords = [
      "yang", "dan", "atau", "untuk", "dengan",
      "apa", "berapa", "tolong", "dong", "saya",
      "mau", "ingin", "ada", "produk", "produkya",
      "watsons", "jual", "tampilkan", "cari",
      "kasih", "lihat", "daftar"
    ];

    const keywords = tokens.filter(
      token => !stopWords.includes(token)
    );

    if (keywords.length === 0) return [];

    const scored = this.products.map(product => {
      let score = 0;

      const searchableText = [
        product.nama,
        product.kategori,
        product.deskripsi
      ].join(" ").toLowerCase();

      for (const keyword of keywords) {
        if (product.nama.toLowerCase().includes(keyword)) {
          score += 8;
        }

        if (product.kategori.toLowerCase().includes(keyword)) {
          score += 5;
        }

        if (product.deskripsi.toLowerCase().includes(keyword)) {
          score += 3;
        }

        if (searchableText.includes(keyword)) {
          score += 1;
        }
      }

      return { product, score };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(item => item.product);
  }

  // Menyusun konteks produk untuk Groq
  buildContext(query) {
    const relevantProducts = this.search(query);

    if (!relevantProducts.length) return "";

    let output = "KATALOG PRODUK WATSONS SHOPEE\n";
    output += `Jumlah produk ditemukan: ${relevantProducts.length}\n`;

    relevantProducts.forEach((product, index) => {
      output += `\nProduk ${index + 1}\n`;
      output += `Nama: ${product.nama}\n`;
      output += `Kategori: ${product.kategori}\n`;
      output += `Harga: ${this.formatCurrency(product.harga)}\n`;
      output += `Deskripsi: ${
        product.deskripsi || "Belum tersedia dalam data."
      }\n`;
      output += `Gambar: ${product.gambar || "Tidak tersedia"}\n`;
      output += `Link Shopee: ${product.href || "Tidak tersedia"}\n`;
    });

    return output.trim();
  }
}

module.exports = RAGEngine;
