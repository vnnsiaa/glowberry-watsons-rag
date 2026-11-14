const test = require("node:test");
const assert = require("node:assert/strict");

// Test ini tidak memanggil Groq: hanya memakai sapaan, FAQ, dan validasi input.

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

async function call(handler, req) {
  const res = mockRes();
  await handler({ method: "GET", query: {}, headers: {}, ...req }, res);
  return res;
}

// ---------- Vercel Functions (api/*.js) ----------

test("api/products: 30 produk, kategori, method lain ditolak", async () => {
  const handler = require("../api/products");
  const res = await call(handler, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 30);
  assert.equal(res.body.products.length, 30);
  assert.ok(res.body.categories.length >= 5);

  const bad = await call(handler, { method: "POST" });
  assert.equal(bad.statusCode, 405);
});

test("api/knowledge: mengembalikan keywords & responses", async () => {
  const res = await call(require("../api/knowledge"), {});
  assert.equal(res.statusCode, 200);
  assert.ok(Object.keys(res.body.keywords).length > 0);
  assert.ok(res.body.responses["cara pesan"]);
});

test("api/chat: validasi input", async () => {
  const handler = require("../api/chat");
  assert.equal((await call(handler, { method: "GET" })).statusCode, 405);
  assert.equal((await call(handler, { method: "POST", body: {} })).statusCode, 400);
  assert.equal((await call(handler, { method: "POST", body: { message: "   " } })).statusCode, 400);
  assert.equal((await call(handler, { method: "POST", body: { message: 123 } })).statusCode, 400);
  assert.equal((await call(handler, { method: "POST", body: "{bukan json" })).statusCode, 400);
  assert.equal(
    (await call(handler, { method: "POST", body: { message: "a".repeat(1001) } })).statusCode,
    413
  );
});

test("api/chat: sapaan & FAQ berhasil", async () => {
  const handler = require("../api/chat");
  const hi = await call(handler, { method: "POST", body: { message: "halo" } });
  assert.equal(hi.statusCode, 200);
  assert.equal(hi.body.source, "greeting");

  const faq = await call(handler, { method: "POST", body: JSON.stringify({ message: "Bagaimana cara membeli produk?" }) });
  assert.equal(faq.statusCode, 200);
  assert.equal(faq.body.source, "faq");
});

test("api/config & api/health tidak membocorkan secret", async () => {
  const config = await call(require("../api/config"), {});
  const health = await call(require("../api/health"), {});
  const dump = JSON.stringify([config.body, health.body]);

  assert.equal(health.body.products, 30);
  assert.ok(!/gsk_|api_key|apiKey/i.test(dump), "respons memuat sesuatu yang mirip API key");
  if (process.env.GROQ_API_KEY) assert.ok(!dump.includes(process.env.GROQ_API_KEY));
});

test("api/groq/quota: tanpa fresh tidak memanggil Groq", async () => {
  const res = await call(require("../api/groq/quota"), {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok("model" in res.body);
});

// ---------- server-v2.js (Express) ----------

test("server-v2: endpoint katalog, chat, bot status & proteksi admin", async t => {
  process.env.ADMIN_TOKEN = "token-uji";
  process.env.AUTO_START_BOT = "false";
  delete require.cache[require.resolve("../server-v2")];
  const { app } = require("../server-v2");

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = path => fetch(base + path).then(async r => ({ status: r.status, body: await r.json() }));
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body || {})
    }).then(async r => ({ status: r.status, body: await r.json() }));

  // Katalog & knowledge (dengan dan tanpa akhiran .js)
  for (const path of ["/api/products", "/api/products.js"]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.body.products.length, 30);
  }
  assert.equal((await get("/api/knowledge")).status, 200);
  assert.equal((await get("/api/config")).body.waGatewayUrl, "");
  assert.equal((await get("/api/health")).body.products, 30);

  // Chat
  assert.equal((await post("/api/chat", { message: "" })).status, 400);
  assert.equal((await post("/api/chat", "{rusak")).status, 400);
  const hi = await post("/api/chat.js", { message: "hai" });
  assert.equal(hi.status, 200);
  assert.equal(hi.body.source, "greeting");

  // Bot WhatsApp
  const status = await get("/api/bot/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.isReady, false);
  assert.equal(status.body.adminTokenRequired, true);

  assert.equal((await get("/api/bot/qr")).status, 401);
  assert.equal((await post("/api/bot/start", {})).status, 401);
  assert.equal((await post("/api/bot/stop", {})).status, 401);
  assert.equal((await post("/api/bot/reset", {}, { "X-Admin-Token": "salah" })).status, 401);

  // Stop dengan token benar saat bot belum berjalan -> aman
  const stop = await post("/api/bot/stop", {}, { "X-Admin-Token": "token-uji" });
  assert.equal(stop.status, 200);

  // Endpoint tidak dikenal -> JSON 404
  assert.equal((await get("/api/tidak-ada")).status, 404);

  // Static frontend
  const html = await fetch(base + "/").then(r => r.text());
  assert.match(html, /<title>Glowberry/);
});

test("server-v2: helper WhatsApp", () => {
  const { formatWhatsAppMessage, maskPhoneNumber } = require("../server-v2");
  assert.equal(formatWhatsAppMessage("**Pantene**\n\n\n\nRp13.000"), "*Pantene*\n\nRp13.000");
  assert.equal(maskPhoneNumber("6281234567890"), "08xxxxxxx7890");
});
