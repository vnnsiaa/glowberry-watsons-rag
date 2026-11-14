const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const RAGEngine = require("../lib/rag");

const rag = new RAGEngine(path.join(__dirname, "..", "data", "products.csv"));
const names = list => list.map(p => p.nama);

test("katalog memuat 30 produk lengkap dengan harga, gambar, dan link Shopee", () => {
  assert.equal(rag.products.length, 30);
  for (const p of rag.products) {
    assert.ok(p.nama, "nama kosong");
    assert.ok(p.hargaAngka > 0, `harga tidak valid: ${p.nama}`);
    assert.match(p.gambar, /^https:\/\/down-id\.img\.susercontent\.com\//, `gambar: ${p.nama}`);
    assert.match(p.href, /^https:\/\/shopee\.co\.id\/.+-i\.\d+\.\d+/, `link: ${p.nama}`);
  }
});

test("setiap produk punya kategori selain 'Lainnya'", () => {
  for (const p of rag.products) assert.notEqual(p.kategori, "Lainnya", p.nama);
  assert.ok(rag.getCategories().length >= 5);
});

test("parsePrice memahami format Indonesia", () => {
  assert.equal(rag.parsePrice("13.000"), 13000);
  assert.equal(rag.parsePrice("Rp 273.750"), 273750);
  assert.equal(rag.parsePrice(""), 0);
  assert.equal(rag.formatCurrency("1.500").replace(/\s/g, " "), "Rp 1.500");
});

test("parseCSV mendukung koma dan tanda kutip di dalam field", () => {
  const rows = rag.parseCSV('nama,harga\n"Produk, ""A""","1.000"\n');
  assert.deepEqual(rows, [{ nama: 'Produk, "A"', harga: "1.000" }]);
});

test("Produk Hada Labo apa saja? -> semua & hanya produk Hada Labo", () => {
  const result = rag.search("Produk Hada Labo apa saja?");
  assert.equal(result.length, 4);
  assert.ok(names(result).every(n => n.startsWith("Hada Labo")));
});

test("Apa produk termurah? -> diurutkan dari harga terendah", () => {
  const result = rag.search("Apa produk termurah?");
  assert.equal(result[0].nama, "Vicee Lemon Tablet Strip 2'S");
  for (let i = 1; i < result.length; i++) {
    assert.ok(result[i - 1].hargaAngka <= result[i].hargaAngka);
  }
});

test("produk termahal", () => {
  const result = rag.search("produk paling mahal");
  assert.match(result[0].nama, /^Labore/);
});

test("Berapa harga produk Pantene? -> produk Pantene", () => {
  const result = rag.search("Berapa harga produk Pantene?");
  assert.equal(result.length, 1);
  assert.match(result[0].nama, /^Pantene/);
  assert.equal(result[0].harga, "13.000");
});

test("Rekomendasikan produk perawatan wajah -> mayoritas kategori Perawatan Wajah", () => {
  const result = rag.search("Rekomendasikan produk perawatan wajah.");
  assert.ok(result.length > 0);
  const face = result.filter(p => p.kategori === "Perawatan Wajah");
  assert.ok(face.length >= result.length - 1, names(result).join(", "));
});

test("sunscreen murah -> hanya tabir surya, urut harga", () => {
  const result = rag.search("sunscreen murah");
  assert.ok(result.length >= 2);
  assert.ok(result.every(p => p.kategori === "Tabir Surya"));
  assert.ok(result[0].hargaAngka <= result[1].hargaAngka);
});

// ---------- Regression: pencarian harga tidak boleh mengabaikan filter merek/kategori ----------

const isSortedAsc = list => list.every((p, i) => i === 0 || list[i - 1].hargaAngka <= p.hargaAngka);
const isSortedDesc = list => list.every((p, i) => i === 0 || list[i - 1].hargaAngka >= p.hargaAngka);

test("regression: 'Apa produk termurah?' = produk termurah dari seluruh katalog", () => {
  const result = rag.search("Apa produk termurah?");
  const min = Math.min(...rag.products.map(p => p.hargaAngka));
  assert.equal(result[0].hargaAngka, min);
  assert.ok(isSortedAsc(result));
});

test("regression: 'Apa produk termahal?' = produk termahal dari seluruh katalog", () => {
  const result = rag.search("Apa produk termahal?");
  const max = Math.max(...rag.products.map(p => p.hargaAngka));
  assert.equal(result[0].hargaAngka, max);
  assert.match(result[0].nama, /^Labore/);
  assert.ok(isSortedDesc(result));
});

test("regression: 'Sunscreen murah' hanya Tabir Surya, urut termurah, dan lengkap", () => {
  const result = rag.search("Sunscreen murah");
  const allSun = rag.products.filter(p => p.kategori === "Tabir Surya");
  assert.ok(result.length > 0);
  assert.ok(result.every(p => p.kategori === "Tabir Surya"), result.map(p => p.nama).join(", "));
  assert.ok(isSortedAsc(result));
  assert.equal(result[0].hargaAngka, Math.min(...allSun.map(p => p.hargaAngka)));
});

test("regression: merek + harga tetap terfilter ke merek tersebut", () => {
  const cheap = rag.search("Hada Labo termurah");
  assert.equal(cheap.length, 4);
  assert.ok(cheap.every(p => p.nama.startsWith("Hada Labo")));
  assert.ok(isSortedAsc(cheap));
  assert.equal(cheap[0].harga, "24.000");

  const pricey = rag.search("cetaphil paling mahal");
  assert.ok(pricey.every(p => p.nama.startsWith("Cetaphil")));
  assert.ok(isSortedDesc(pricey));
  assert.equal(pricey[0].harga, "205.500");
});

test("regression: harga dibandingkan numerik, bukan alfabetis", () => {
  // Secara alfabetis "1.500" < "11.000" < "254.000" < "3.500"; secara numerik 3.500 harus sebelum 11.000
  const result = rag.search("produk termurah");
  const prices = result.map(p => p.hargaAngka);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const idx3500 = result.findIndex(p => p.harga === "3.500");
  const idx11000 = result.findIndex(p => p.harga === "11.000");
  assert.ok(idx3500 !== -1 && idx11000 !== -1 && idx3500 < idx11000);
});

test("pertanyaan tanpa produk & sapaan tidak mengambil konteks", () => {
  assert.deepEqual(rag.search("Bagaimana cara membeli produk?"), []);
  assert.deepEqual(rag.search("halo"), []);
  assert.deepEqual(rag.search("jual laptop gaming"), []);
});

test("permintaan katalog lengkap mengembalikan seluruh produk", () => {
  assert.equal(rag.search("katalog").length, 30);
  assert.equal(rag.search("produk apa saja?").length, 30);
});

test("buildContext memuat nama, harga, dan URL Shopee persis", () => {
  const context = rag.buildContext("Pantene");
  const pantene = rag.products.find(p => p.nama.startsWith("Pantene"));
  assert.match(context, /Nama: Pantene/);
  assert.match(context, /Harga: Rp\s13\.000/);
  assert.ok(context.includes(`Link Shopee: ${pantene.href}`));
});
