const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GlowberryChatbot,
  isGreeting,
  isGratitude,
  stripReasoning,
  hasUsableKey
} = require("../lib/chatbot");

// Groq palsu: merekam request dan mengembalikan jawaban yang ditentukan
function fakeGroq(behaviour) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create(params) {
          calls.push(params);
          const run = async () => {
            const out = await behaviour(params, calls.length);
            return {
              data: { choices: [{ message: { content: out } }] },
              response: {
                headers: new Map([
                  ["x-ratelimit-remaining-requests", "999"],
                  ["x-ratelimit-limit-requests", "1000"]
                ])
              }
            };
          };
          return { withResponse: run };
        }
      }
    }
  };
}

const env = { GROQ_MODEL: "model-utama", GROQ_FALLBACK_MODELS: "model-cadangan" };

test("deteksi sapaan & terima kasih", () => {
  assert.ok(isGreeting("Halo"));
  assert.ok(isGreeting("hai kak!"));
  assert.ok(!isGreeting("halo, ada sunscreen?"));
  assert.ok(!isGreeting("berapa harga pantene"));
  assert.ok(isGratitude("makasih kak"));
  assert.ok(!isGratitude("pantene"));
});

test("stripReasoning menghapus blok <think>", () => {
  assert.equal(stripReasoning("<think>rahasia</think>\nHalo Kak"), "Halo Kak");
});

test("hasUsableKey menolak placeholder", () => {
  assert.ok(!hasUsableKey(""));
  assert.ok(!hasUsableKey("isi_api_key_groq"));
  assert.ok(hasUsableKey("gsk_example"));
});

test("sapaan dijawab tanpa memanggil Groq", async () => {
  const groq = fakeGroq(() => "tidak boleh dipanggil");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  const result = await bot.reply("Halo");
  assert.equal(result.source, "greeting");
  assert.equal(groq.calls.length, 0);
});

test("FAQ cara membeli dijawab dari knowledge.json", async () => {
  const groq = fakeGroq(() => "tidak boleh dipanggil");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  const result = await bot.reply("Bagaimana cara membeli produk?");
  assert.equal(result.source, "faq");
  assert.match(result.reply, /Beli di Shopee/);
  assert.equal(groq.calls.length, 0);
});

test("FAQ pengiriman & pembayaran", async () => {
  const bot = new GlowberryChatbot({ env: {} });
  assert.match((await bot.reply("berapa ongkir nya?")).reply, /checkout Shopee/);
  assert.match((await bot.reply("bisa bayar cod?")).reply, /Pembayaran/);
});

test("pertanyaan produk mengirim konteks katalog (RAG) ke Groq", async () => {
  const groq = fakeGroq(() => "Pantene harganya Rp13.000 Kak");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  const result = await bot.reply("Berapa harga produk Pantene?");

  assert.equal(result.source, "groq");
  assert.equal(result.model, "model-utama");
  const system = groq.calls[0].messages[0].content;
  assert.match(system, /Nama: Pantene Pro-V Perfect On Conditioner/);
  assert.match(system, /Harga: Rp\s13\.000/);
  assert.match(system, /https:\/\/shopee\.co\.id\/Pantene/);
  assert.doesNotMatch(system, /Hada Labo/, "konteks tidak boleh berisi produk yang tidak relevan");
  assert.equal(groq.calls[0].messages.at(-1).content, "Berapa harga produk Pantene?");
});

test("bila model utama gagal, model cadangan dipakai", async () => {
  const groq = fakeGroq(params => {
    if (params.model === "model-utama") throw Object.assign(new Error("rate limit"), { status: 429 });
    return "jawaban cadangan";
  });
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  const result = await bot.reply("produk Hada Labo");
  assert.equal(result.model, "model-cadangan");
  assert.equal(result.reply, "jawaban cadangan");
});

test("model yang kena 429 dilewati (cooldown) pada request berikutnya", async () => {
  const groq = fakeGroq(params => {
    if (params.model === "model-utama") {
      throw Object.assign(new Error("Rate limit reached. Please try again in 7.5s."), { status: 429 });
    }
    return "ok";
  });
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("pantene");
  assert.equal(groq.calls.length, 2);
  await bot.reply("hada labo");
  assert.equal(groq.calls.length, 3, "model-utama seharusnya tidak dicoba lagi");
  assert.equal(groq.calls[2].model, "model-cadangan");
  const wait = bot.cooldowns.get("model-utama") - Date.now();
  assert.ok(wait > 6000 && wait <= 7500, `cooldown ${wait} ms`);
});

test("bila semua model gagal, fallback memakai data katalog asli", async () => {
  const groq = fakeGroq(() => {
    throw new Error("down");
  });
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  const result = await bot.reply("produk Hada Labo");
  assert.equal(result.source, "fallback");
  assert.match(result.reply, /Hada Labo Gokujyun/);
  assert.match(result.reply, /https:\/\/shopee\.co\.id\//);
});

test("tanpa API key, chatbot tetap menjawab dari katalog (tanpa error)", async () => {
  const bot = new GlowberryChatbot({ env: { GROQ_API_KEY: "isi_api_key_groq" } });
  assert.equal(bot.isConfigured(), false);
  const result = await bot.reply("Berapa harga Pantene?");
  assert.equal(result.source, "fallback");
  assert.match(result.reply, /Rp\s13\.000/);
});

test("produk tidak ada di katalog -> jawaban jujur, tanpa produk karangan", async () => {
  const bot = new GlowberryChatbot({ env: {} });
  const result = await bot.reply("jual laptop gaming?");
  assert.match(result.reply, /belum menemukan/);
  assert.deepEqual(result.products, []);
});

test("riwayat percakapan dipakai untuk pertanyaan lanjutan", async () => {
  const groq = fakeGroq(() => "ok");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("berapa harganya?", {
    history: [
      { role: "user", content: "ada produk Cetaphil?" },
      { role: "assistant", content: "Ada Kak" }
    ]
  });
  assert.match(groq.calls[0].messages[0].content, /Cetaphil Gentle Skin Cleanser/);
});

test("kuota Groq diperbarui dari header respons", async () => {
  const groq = fakeGroq(() => "ok");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("pantene");
  const quota = bot.getQuota();
  assert.equal(quota.remainingRequests, 999);
  assert.equal(quota.limitRequests, 1000);
});
