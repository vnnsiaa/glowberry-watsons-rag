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
