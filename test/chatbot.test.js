const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GlowberryChatbot,
  isGreeting,
  isGratitude,
  stripReasoning,
  hasUsableKey,
  splitQuestions
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

// ---------- Multi-question: produk antarpertanyaan tidak boleh tercampur ----------

const FOUR_QUESTIONS = "Apa saja produk Hada Labo? Apa produk paling murah? Sunscreen murah? Produk termahal?";

test("splitQuestions memecah pertanyaan dengan ?, baris baru, nomor, 'dan'", () => {
  assert.deepEqual(splitQuestions(FOUR_QUESTIONS), [
    "Apa saja produk Hada Labo", "Apa produk paling murah", "Sunscreen murah", "Produk termahal"
  ]);
  assert.deepEqual(splitQuestions("1. hada labo\n2. sunscreen murah"), ["hada labo", "sunscreen murah"]);
  assert.deepEqual(splitQuestions("Hada Labo termurah dan sunscreen murah"), ["Hada Labo termurah", "sunscreen murah"]);
  assert.deepEqual(splitQuestions("Berapa harga Pantene?"), ["Berapa harga Pantene"]);
});

test("splitQuestions memecah empat pertanyaan yang dipisahkan titik tanpa merusak URL, desimal, atau singkatan", () => {
  assert.deepEqual(
    splitQuestions("Apa produk termurah? Apa produk termahal? Sunscreen murah. Hada Labo termurah."),
    ["Apa produk termurah", "Apa produk termahal", "Sunscreen murah", "Hada Labo termurah"]
  );
  assert.deepEqual(splitQuestions("Kadar 1.5%? Dr. Hada Labo. Sunscreen murah."), [
    "Kadar 1.5%", "Dr. Hada Labo", "Sunscreen murah"
  ]);
  assert.deepEqual(splitQuestions("Cek https://example.com/path.v1 Hada Labo. Sunscreen murah."), [
    "Cek https://example.com/path.v1 Hada Labo", "Sunscreen murah"
  ]);
});

test("empat pertanyaan dipisahkan tanda titik menjalankan retrieval independen", () => {
  const bot = new GlowberryChatbot({ env: {} });
  const groups = bot.retrieve("Apa produk termurah? Apa produk termahal? Sunscreen murah. Hada Labo termurah.");
  assert.equal(groups.length, 4);
  assert.equal(groups[0].products[0].nama, "Vicee Lemon Tablet Strip 2'S");
  assert.match(groups[1].products[0].nama, /^Labore/);
  assert.ok(groups[2].products.length > 0);
  assert.ok(groups[2].products.every(p => p.kategori === "Tabir Surya"));
  assert.ok(groups[2].products.every((p, i, a) => i === 0 || a[i - 1].hargaAngka <= p.hargaAngka));
  assert.ok(groups[3].products.length > 0);
  assert.ok(groups[3].products.every(p => p.nama.startsWith("Hada Labo")));
  assert.ok(groups[3].products.every((p, i, a) => i === 0 || a[i - 1].hargaAngka <= p.hargaAngka));
});

test("empat pertanyaan dalam satu pesan -> retrieval terpisah per pertanyaan", () => {
  const bot = new GlowberryChatbot({ env: {} });
  const groups = bot.retrieve(FOUR_QUESTIONS);
  assert.equal(groups.length, 4);

  const [hada, cheapest, sun, priciest] = groups;
  assert.ok(hada.products.every(p => p.nama.startsWith("Hada Labo")));
  assert.equal(cheapest.products[0].nama, "Vicee Lemon Tablet Strip 2'S");
  assert.ok(cheapest.products.every((p, i, a) => i === 0 || a[i - 1].hargaAngka <= p.hargaAngka));
  assert.ok(sun.products.every(p => p.kategori === "Tabir Surya"));
  assert.ok(sun.products.every((p, i, a) => i === 0 || a[i - 1].hargaAngka <= p.hargaAngka));
  assert.match(priciest.products[0].nama, /^Labore/);
  assert.ok(priciest.products.every((p, i, a) => i === 0 || a[i - 1].hargaAngka >= p.hargaAngka));
});

test("Hada Labo termurah + sunscreen murah dalam satu pesan tidak tercampur", () => {
  const bot = new GlowberryChatbot({ env: {} });
  const [hada, sun] = bot.retrieve("Hada Labo termurah dan sunscreen murah");
  assert.ok(hada.products.every(p => p.nama.startsWith("Hada Labo")));
  assert.equal(hada.products[0].harga, "24.000");
  assert.ok(sun.products.every(p => p.kategori === "Tabir Surya"));
});

test("satu pertanyaan dengan 'dan' tetap diperlakukan sebagai satu pertanyaan", () => {
  const bot = new GlowberryChatbot({ env: {} });
  const groups = bot.retrieve("sunscreen murah dan bagus");
  assert.equal(groups.length, 1);
  assert.ok(groups[0].products.every(p => p.kategori === "Tabir Surya"));
});

test("multi-question: konteks Groq dibagi per pertanyaan", async () => {
  const groq = fakeGroq(() => "ok");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("Hada Labo termurah dan sunscreen murah");
  const system = groq.calls[0].messages[0].content;
  const [, part1, part2] = system.split(/=== PERTANYAAN \d+: /);
  assert.ok(part1 && part2, "konteks harus memiliki 2 bagian");
  assert.match(part1, /Hada Labo/);
  assert.doesNotMatch(part1, /Emina|Azarine|Skin Aqua/);
  assert.match(part2, /Emina|Azarine|Skin Aqua/);
  assert.doesNotMatch(part2.split("INFORMASI LAYANAN")[0], /Hada Labo/);
});

test("multi-question: fallback tanpa Groq menjawab per pertanyaan", async () => {
  const bot = new GlowberryChatbot({ env: {} });
  const result = await bot.reply(FOUR_QUESTIONS);
  const sections = result.reply.split(/\n\*/).slice(1);
  assert.equal(sections.length, 4);
  assert.match(sections[0], /^Apa saja produk Hada Labo\*/);
  assert.doesNotMatch(sections[0], /Emina|Vicee|Labore/);
  assert.match(sections[1], /Vicee/);
  assert.match(sections[2], /Emina|Azarine|Skin Aqua/);
  assert.doesNotMatch(sections[2], /Hada Labo/);
  assert.match(sections[3], /Labore/);
});

test("pesan berurutan tanpa history tidak saling mencemari (web API stateless)", async () => {
  const groq = fakeGroq(() => "ok");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("Apa saja produk Hada Labo?");
  await bot.reply("Sunscreen murah");
  const second = groq.calls[1].messages;
  assert.equal(second.length, 2, "hanya system + pertanyaan saat ini");
  assert.doesNotMatch(second[0].content, /Hada Labo/);
});

test("kuota Groq diperbarui dari header respons", async () => {
  const groq = fakeGroq(() => "ok");
  const bot = new GlowberryChatbot({ groqClient: groq, env });
  await bot.reply("pantene");
  const quota = bot.getQuota();
  assert.equal(quota.remainingRequests, 999);
  assert.equal(quota.limitRequests, 1000);
});
