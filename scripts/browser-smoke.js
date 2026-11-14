#!/usr/bin/env node
/**
 * Smoke test frontend di browser sungguhan (Puppeteer / Chromium bawaan whatsapp-web.js).
 *
 *   node scripts/browser-smoke.js                      -> http://localhost:3001
 *   node scripts/browser-smoke.js https://xxx.vercel.app
 *
 * Screenshot disimpan di test-results/.
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const BASE = (process.argv[2] || process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const OUT = path.join(__dirname, "..", "test-results");
const SKIP_CHAT = process.argv.includes("--no-chat");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
};

async function runViewport(browser, name, viewport) {
  console.log(`\n[${name}] ${viewport.width}x${viewport.height}`);
  const page = await browser.newPage();
  await page.setViewport(viewport);

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", err => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", req => failedRequests.push(`${req.url()} (${req.failure()?.errorText})`));
  page.on("response", res => {
    if (res.status() >= 400 && res.url().startsWith(BASE)) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(".product-card", { timeout: 20000 });

  // Katalog
  const cards = await page.$$eval(".product-card", els => els.length);
  check(cards === 30, `30 kartu produk tampil (${cards})`);

  const count = await page.$eval("#productCount", el => el.textContent.trim());
  check(count === "30 produk ditemukan", `info jumlah: "${count}"`);

  // Scroll ke seluruh katalog agar gambar lazy-load termuat
  await page.evaluate(async () => {
    for (const img of document.querySelectorAll(".product-image img")) {
      img.loading = "eager";
    }
    document.querySelector("#products").scrollIntoView();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".product-image img")].every(img => img.complete),
    { timeout: 30000 }
  ).catch(() => {});
  const images = await page.$$eval(".product-image img", imgs => ({
    total: imgs.length,
    broken: imgs.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.alt)
  }));
  check(images.total === 30 && images.broken.length === 0,
    `gambar produk termuat (${images.total - images.broken.length}/30)` +
    (images.broken.length ? ` rusak: ${images.broken.join(", ")}` : ""));

  // Nama & harga sesuai API
  const api = await page.evaluate(async () => (await fetch("/api/products")).json());
  const shown = await page.$$eval(".product-card", els => els.map(el => ({
    nama: el.querySelector(".product-name").textContent.trim(),
    harga: el.querySelector(".product-price").textContent.replace(/\s/g, " ").trim(),
    href: el.querySelector("a.buy-link")?.href
  })));
  const mismatch = shown.filter((s, i) => {
    const p = api.products[i];
    const digits = String(p.harga).replace(/\D/g, "");
    return s.nama !== p.nama || s.harga.replace(/\D/g, "") !== digits || s.href !== new URL(p.href).href;
  });
  check(mismatch.length === 0, `nama, harga, dan link Shopee tiap kartu sama dengan data API${mismatch.length ? ` (${mismatch.length} beda)` : ""}`);
  check(shown.every(s => /^https:\/\/shopee\.co\.id\//.test(s.href || "")), "semua tombol Beli mengarah ke shopee.co.id");
  const targets = await page.$$eval("a.buy-link", els => els.every(a => a.target === "_blank" && a.rel.includes("noopener")));
  check(targets, "link Shopee dibuka di tab baru (noopener)");

  // Encoding
  const bodyText = await page.evaluate(() => document.body.innerText);
  check(!/\u00e2\u2020|\u00e2\u20ac|\u00f0\u0178|\u00c3\u00a9|\u00e2\u0153/.test(bodyText), "tidak ada karakter rusak (mojibake) di halaman");

  // Pencarian
  await page.type("#productSearch", "hada labo");
  const searchCount = await page.$$eval(".product-card", els => els.length);
  check(searchCount === 4, `pencarian "hada labo" -> ${searchCount} produk`);
  await page.$eval("#productSearch", el => { el.value = "xyz-tidak-ada"; el.dispatchEvent(new Event("input")); });
  const emptyVisible = await page.$eval("#emptyProducts", el => !el.classList.contains("hidden"));
  check(emptyVisible, "pesan 'belum ketemu' muncul untuk pencarian kosong");
  await page.$eval("#productSearch", el => { el.value = ""; el.dispatchEvent(new Event("input")); });

  // Filter kategori
  const chips = await page.$$eval("#categoryFilters button", els => els.map(e => e.dataset.category));
  check(chips.length >= 6, `chip kategori: ${chips.join(", ")}`);
  await page.click('#categoryFilters button[data-category="Perawatan Rambut"]');
  const hair = await page.$$eval(".product-card .product-category", els => els.map(e => e.textContent.trim()));
  check(hair.length > 0 && hair.every(c => c === "Perawatan Rambut"), `filter Perawatan Rambut -> ${hair.length} produk`);
  await page.click('#categoryFilters button[data-category="all"]');

  // Urutan harga
  const pricesFor = () => page.$$eval(".product-price", els => els.map(e => Number(e.textContent.replace(/\D/g, ""))));
  await page.select("#sortProducts", "low");
  const low = await pricesFor();
  check(low.every((v, i) => i === 0 || low[i - 1] <= v), `urut harga terendah (pertama: ${low[0]})`);
  await page.select("#sortProducts", "high");
  const high = await pricesFor();
  check(high.every((v, i) => i === 0 || high[i - 1] >= v), `urut harga tertinggi (pertama: ${high[0]})`);
  await page.select("#sortProducts", "name");
  const byName = await page.$$eval(".product-name", els => els.map(e => e.textContent.trim()));
  check(byName.every((v, i) => i === 0 || byName[i - 1].localeCompare(v, "id") <= 0), "urut nama A-Z");
  await page.select("#sortProducts", "default");

  // Header sticky tidak menutupi judul section setelah klik anchor
  await page.evaluate(() => window.scrollTo(0, 0));
  if (viewport.width <= 650) {
    await page.click("#mobileMenu");
    const menuOpen = await page.$eval(".nav-links", el => getComputedStyle(el).display !== "none");
    check(menuOpen, "menu mobile terbuka");
  }
  await page.click('.nav-links a[href="#products"]');
  await new Promise(r => setTimeout(r, 1200));
  const overlap = await page.evaluate(() => {
    const nav = document.querySelector(".navbar").getBoundingClientRect();
    const heading = document.querySelector("#products .eyebrow").getBoundingClientRect();
    return { navBottom: nav.bottom, headingTop: heading.top };
  });
  check(overlap.headingTop >= overlap.navBottom - 1,
    `judul katalog tidak tertutup navbar (navbar ${Math.round(overlap.navBottom)}px, judul ${Math.round(overlap.headingTop)}px)`);
  if (viewport.width <= 650) {
    const menuClosed = await page.$eval(".nav-links", el => getComputedStyle(el).display === "none");
    check(menuClosed, "menu mobile tertutup setelah klik link");
  }

  // Tidak ada scroll horizontal
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflowX <= 1, `tidak ada overflow horizontal (${overflowX}px)`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, `${name}-home.png`) });
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, document.querySelector("#products").offsetTop + 380);
  });
  await new Promise(r => setTimeout(r, 400));
  // Navbar harus menutup konten di belakangnya sepenuhnya (tidak tembus pandang)
  const navBg = await page.$eval(".navbar", el => getComputedStyle(el).backgroundColor);
  check(!/^rgba\(.*,\s*0?\.\d+\)$/.test(navBg), `background navbar opaque (${navBg})`);
  await page.screenshot({ path: path.join(OUT, `${name}-catalog.png`) });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = ""; });

  // Chatbot buka / tutup
  await page.click("#chatLauncher");
  const opened = await page.$eval("#chatWindow", el => !el.classList.contains("hidden"));
  check(opened, "chatbot terbuka");
  const chatBox = await page.$eval("#chatWindow", el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });
  check(chatBox.left >= 0 && chatBox.right <= chatBox.vw && chatBox.top >= 0 && chatBox.bottom <= chatBox.vh,
    "jendela chat seluruhnya berada di dalam layar");

  if (!SKIP_CHAT) {
    await page.type("#chatInput", "Berapa harga produk Pantene?");
    await page.click("#sendChat");
    await page.waitForFunction(
      () => !document.querySelector("#typingIndicator") &&
        document.querySelectorAll(".bot-message").length >= 2,
      { timeout: 45000 }
    );
    const reply = await page.$$eval(".bot-message .message-content", els => ({
      text: els.at(-1).innerText,
      links: [...els.at(-1).querySelectorAll("a")].map(a => a.href)
    }));
    check(/13\.000/.test(reply.text), `chatbot menjawab harga Pantene Rp13.000`);
    check(reply.links.length >= 1 && reply.links.every(h => h.startsWith("https://shopee.co.id/Pantene")),
      `link Shopee di jawaban bisa diklik (${reply.links.length})`);
    await page.screenshot({ path: path.join(OUT, `${name}-chat.png`) });
  }

  await page.click("#closeChat");
  const closed = await page.$eval("#chatWindow", el => el.classList.contains("hidden"));
  const launcherBack = await page.$eval("#chatLauncher", el => !el.classList.contains("hidden"));
  check(closed && launcherBack, "chatbot tertutup & tombol launcher kembali");

  // Admin dashboard
  await page.click(".admin-panel > summary");
  await new Promise(r => setTimeout(r, 500));
  const admin = await page.evaluate(() => ({
    rows: document.querySelectorAll("#productsBody tr").length,
    status: document.querySelector("#statusText").textContent,
    knowledge: document.querySelectorAll("#knowledgeList .tag-item").length
  }));
  check(admin.rows === 30, `tabel admin berisi 30 produk (${admin.rows})`);
  check(admin.knowledge > 0, `basis pengetahuan tampil (${admin.knowledge} kata kunci)`);
  console.log(`  · status WhatsApp: ${admin.status}`);

  check(consoleErrors.length === 0, `tidak ada error di console${consoleErrors.length ? `: ${consoleErrors.join(" | ")}` : ""}`);
  const ownFailures = failedRequests.filter(u => u.includes(BASE) || /^\d{3} /.test(u));
  check(ownFailures.length === 0, `tidak ada request gagal ke server sendiri${ownFailures.length ? `: ${ownFailures.join(" | ")}` : ""}`);

  await page.close();
}

(async () => {
  console.log(`Target: ${BASE}`);
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    await runViewport(browser, "desktop", { width: 1366, height: 800 });
    await runViewport(browser, "mobile", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  } finally {
    await browser.close();
  }
  console.log(failures ? `\nGAGAL: ${failures} pemeriksaan.` : "\nSemua smoke test browser lulus.");
  console.log(`Screenshot: ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch(error => {
  console.error("Smoke test gagal dijalankan:", error);
  process.exit(1);
});
