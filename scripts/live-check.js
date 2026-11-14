#!/usr/bin/env node
/**
 * Uji end-to-end terhadap server yang sedang berjalan (memanggil Groq asli).
 *
 *   node scripts/live-check.js                      -> http://localhost:3001
 *   node scripts/live-check.js https://xxx.vercel.app
 *
 * Setiap jawaban diverifikasi terhadap data katalog asli (data/products.csv):
 * nama & harga yang disebut harus ada di katalog, dan setiap URL Shopee pada
 * jawaban harus persis sama dengan URL di katalog.
 */
const path = require("path");
const RAGEngine = require("../lib/rag");

const BASE = (process.argv[2] || process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const originalLog = console.log;
console.log = () => {};
const rag = new RAGEngine(path.join(__dirname, "..", "data", "products.csv"));
console.log = originalLog;

const catalogUrls = new Set(rag.products.map(p => p.href));
const product = prefix => rag.products.find(p => p.nama.startsWith(prefix));
const priceText = p => p.harga; // contoh "13.000"

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
};

async function request(method, url, body) {
  const started = Date.now();
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // bukan JSON
  }
  return { status: res.status, json, text, ms: Date.now() - started };
}

function urlsIn(reply) {
  return (reply.match(/https?:\/\/[^\s<>()]+/g) || []).map(u => u.replace(/[.,!?;:)\]]+$/, ""));
}

const QUESTIONS = [
  {
    q: "Produk Hada Labo apa saja?",
    verify: reply => {
      const hada = rag.products.filter(p => p.nama.startsWith("Hada Labo"));
      check(/hada labo/i.test(reply), "menyebut Hada Labo");
      const mentioned = hada.filter(p => reply.includes(priceText(p)));
      check(mentioned.length >= 3, `menyebut harga asli >= 3 dari 4 produk Hada Labo (${mentioned.length})`);
    }
  },
  {
    q: "Apa produk termurah?",
    verify: reply => {
      const cheapest = product("Vicee Lemon");
      check(/vicee/i.test(reply), "menyebut Vicee Lemon Tablet (produk termurah di katalog)");
      check(reply.includes(priceText(cheapest)), `harga ${priceText(cheapest)} benar`);
    }
  },
  {
    q: "Berapa harga produk Pantene?",
    verify: reply => {
      const pantene = product("Pantene");
      check(/pantene/i.test(reply), "menyebut Pantene");
      check(reply.includes(priceText(pantene)), `harga ${priceText(pantene)} benar`);
    }
  },
  {
    q: "Rekomendasikan produk perawatan wajah.",
    verify: reply => {
      const face = rag.products.filter(p => p.kategori === "Perawatan Wajah");
      const brands = face.filter(p => reply.toLowerCase().includes(p.nama.split(" ").slice(0, 2).join(" ").toLowerCase()));
      check(brands.length >= 1, `merekomendasikan produk perawatan wajah dari katalog (${brands.length} cocok)`);
    }
  },
  {
    q: "Bagaimana cara membeli produk?",
    verify: reply => check(/shopee/i.test(reply) && /beli/i.test(reply), "menjelaskan pembelian via Shopee (FAQ)")
  },
  {
    q: "Ada jual iPhone 15?",
    verify: reply => {
      check(!/rp\s?\d/i.test(reply) || /belum|tidak/i.test(reply), "tidak mengarang produk di luar katalog");
    }
  }
];

(async () => {
  console.log(`Target: ${BASE}\n`);

  console.log("Endpoint dasar");
  const products = await request("GET", "/api/products");
  check(products.status === 200 && products.json?.products?.length === 30, `GET /api/products -> ${products.status}, ${products.json?.products?.length} produk`);
  const knowledge = await request("GET", "/api/knowledge");
  check(knowledge.status === 200 && knowledge.json?.responses, `GET /api/knowledge -> ${knowledge.status}`);
  const health = await request("GET", "/api/health");
  check(health.status === 200 && health.json?.groqConfigured === true, `GET /api/health -> ${health.status}, groqConfigured=${health.json?.groqConfigured}`);
  const config = await request("GET", "/api/config");
  check(config.status === 200, `GET /api/config -> ${config.status}`);
  const bad = await request("POST", "/api/chat", { message: "" });
  check(bad.status === 400, `POST /api/chat pesan kosong -> ${bad.status}`);

  for (const item of QUESTIONS) {
    console.log(`\nQ: ${item.q}`);
    const res = await request("POST", "/api/chat", { message: item.q });
    if (res.status !== 200 || !res.json?.success) {
      check(false, `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      continue;
    }
    const reply = res.json.reply;
    console.log(`  [source=${res.json.source}, ${res.ms} ms]`);
    console.log(reply.split("\n").map(l => "  | " + l).join("\n"));

    item.verify(reply);
    const urls = urlsIn(reply).filter(u => u.includes("shopee"));
    const invalid = urls.filter(u => !catalogUrls.has(u));
    check(invalid.length === 0, `semua URL Shopee (${urls.length}) persis dari katalog` + (invalid.length ? ` -> salah: ${invalid.join(" ")}` : ""));
    check(!/<think>|csv|\brag\b|system prompt|api key/i.test(reply), "tidak membocorkan detail internal");
  }

  console.log(failures ? `\nGAGAL: ${failures} pemeriksaan.` : "\nSemua uji live lulus.");
  process.exit(failures ? 1 : 0);
})().catch(error => {
  console.error("Uji live gagal dijalankan:", error.message);
  process.exit(1);
});
