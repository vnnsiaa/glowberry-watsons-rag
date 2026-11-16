// Glowberry frontend
// API katalog & chatbot selalu di origin yang sama (Vercel Functions atau server-v2.js).
// WhatsApp Gateway bisa berada di server lain (lihat /api/config -> waGatewayUrl).
const API = "";
let allProducts = [];
let activeCategory = "all";
let botStatusTimer = null;
let qrLastValue = null;
let gatewayUrl = null; // null = gateway tidak tersedia, "" = origin yang sama

const $ = (selector) => document.querySelector(selector);

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function numericPrice(value) {
  return Number(String(value || "0").replace(/[^\d]/g, "")) || 0;
}

function rupiah(value) {
  const number = numericPrice(value);
  if (!number) return "Harga belum tersedia";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(number);
}

// Hanya izinkan link Shopee https agar tidak ada URL berbahaya di href
function safeShopeeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && /(^|\.)shopee\.co\.id$/.test(parsed.hostname)) {
      return parsed.href;
    }
  } catch {
    // URL tidak valid
  }
  return null;
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

// ===============================
// LOAD PRODUK DARI BACKEND RAG
// ===============================

async function loadProducts() {
  const grid = $("#productGrid");

  try {
    const { response, data } = await fetchJSON(`${API}/api/products`);
    if (!response.ok || !data || !Array.isArray(data.products)) {
      throw new Error((data && data.error) || "Gagal mengambil data produk");
    }

    allProducts = data.products;

    renderCategories();
    renderProducts();
    renderAdminProducts();
  } catch (error) {
    console.warn("Gagal memuat produk:", error.message);
    grid.innerHTML = `
      <div class="loading-products">
        Produk belum dapat dimuat. Silakan muat ulang halaman sebentar lagi ya, Kak.
      </div>
    `;
    $("#productCount").textContent = "Gagal memuat produk";
  }
}

function renderAdminProducts() {
  const tbody = $("#productsBody");
  if (!tbody) return;

  tbody.innerHTML = allProducts.map(product => {
    const href = safeShopeeUrl(product.href);
    return `
      <tr>
        <td>${escapeHTML(product.nama)}</td>
        <td>${escapeHTML(product.kategori)}</td>
        <td>${escapeHTML(rupiah(product.harga))}</td>
        <td>${href
          ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">Buka Shopee ↗</a>`
          : "-"}</td>
      </tr>
    `;
  }).join("");
}

// ===============================
// KATEGORI PRODUK
// ===============================

function renderCategories() {
  const container = $("#categoryFilters");
  if (!container) return;

  const categories = [...new Set(allProducts.map(p => p.kategori).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "id"));

  const chip = (value, label) => `
    <button type="button" class="filter-chip ${activeCategory === value ? "active" : ""}"
      data-category="${escapeHTML(value)}" aria-pressed="${activeCategory === value}">
      ${escapeHTML(label)}
    </button>`;

  container.innerHTML =
    chip("all", `All Products (${allProducts.length})`) +
    categories.map(category => {
      const count = allProducts.filter(p => p.kategori === category).length;
      return chip(category, `${category} (${count})`);
    }).join("");

  container.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      activeCategory = button.dataset.category;
      renderCategories();
      renderProducts();
    });
  });
}

// ===============================
// TAMPILKAN KATALOG PRODUK
// ===============================

function renderProducts() {
  const grid = $("#productGrid");
  const search = ($("#productSearch")?.value || "").toLowerCase().trim();
  const terms = search.split(/\s+/).filter(Boolean);
  const sort = $("#sortProducts")?.value || "default";

  const products = allProducts.filter(product => {
    const searchable = [product.nama, product.kategori, product.deskripsi]
      .join(" ")
      .toLowerCase();

    const matchesSearch = terms.every(term => searchable.includes(term));
    const matchesCategory = activeCategory === "all" || product.kategori === activeCategory;

    return matchesSearch && matchesCategory;
  });

  if (sort === "low") {
    products.sort((a, b) => numericPrice(a.harga) - numericPrice(b.harga));
  } else if (sort === "high") {
    products.sort((a, b) => numericPrice(b.harga) - numericPrice(a.harga));
  } else if (sort === "name") {
    products.sort((a, b) => a.nama.localeCompare(b.nama, "id"));
  }

  $("#productCount").textContent = `${products.length} produk ditemukan`;
  $("#emptyProducts").classList.toggle("hidden", products.length !== 0);

  if (products.length === 0) {
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = products.map(product => {
    const image = product.gambar || "";
    const href = safeShopeeUrl(product.href);

    return `
      <article class="product-card">
        <div class="product-image">
          <span class="product-tag">✿ Glowberry Pick</span>
          ${image
            ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.nama)}"
                 loading="lazy" referrerpolicy="no-referrer">`
            : ""}
          <span class="product-image-fallback" aria-hidden="true">🍓</span>
        </div>

        <div class="product-info">
          <div class="product-category">${escapeHTML(product.kategori || "Beauty & Care")}</div>
          <div class="product-name" title="${escapeHTML(product.nama)}">${escapeHTML(product.nama)}</div>
          <div class="product-price">${escapeHTML(rupiah(product.harga))}</div>

          <div class="product-actions">
            ${href
              ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" class="buy-link">
                   Beli di Shopee ↗
                 </a>`
              : `<span class="buy-link disabled">Link belum tersedia</span>`}
          </div>
        </div>
      </article>
    `;
  }).join("");

  // Gambar rusak: sembunyikan <img> dan tampilkan ikon pengganti
  grid.querySelectorAll(".product-image img").forEach(img => {
    img.addEventListener("error", () => {
      img.remove();
    }, { once: true });
  });
}

$("#productSearch")?.addEventListener("input", renderProducts);
$("#sortProducts")?.addEventListener("change", renderProducts);

// ===============================
// CHATBOT GLOWBERRY
// ===============================

function openChat() {
  $("#chatWindow").classList.remove("hidden");
  $("#chatLauncher").classList.add("hidden");
  $("#chatInput").focus();
}

function closeChat() {
  $("#chatWindow").classList.add("hidden");
  $("#chatLauncher").classList.remove("hidden");
}

$("#chatLauncher").addEventListener("click", openChat);
$("#closeChat").addEventListener("click", closeChat);
$("#openChatPromo").addEventListener("click", openChat);

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#chatWindow").classList.contains("hidden")) {
    closeChat();
  }
});

// Render teks jawaban AI dengan aman: hanya **tebal** dan link Shopee yang diubah
// menjadi elemen; selebihnya tetap teks biasa (tidak ada innerHTML dari AI).
function renderRichText(container, text) {
  const tokenPattern = /(\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const token = match[0];

    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
    } else {
      // Pisahkan tanda baca di akhir URL
      const trimmed = token.replace(/[.,!?;:]+$/, "");
      const trailing = token.slice(trimmed.length);
      const href = safeShopeeUrl(trimmed);

      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Lihat di Shopee ↗";
        link.className = "chat-link";
        container.appendChild(link);
      } else {
        container.appendChild(document.createTextNode(trimmed));
      }
      if (trailing) container.appendChild(document.createTextNode(trailing));
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function addMessage(text, type = "bot") {
  const messages = $("#chatMessages");
  const message = document.createElement("div");

  message.className = type === "user" ? "message user-message" : "message bot-message";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = type === "user" ? "♡" : "🍓";

  const content = document.createElement("div");
  content.className = "message-content";

  if (type === "user") {
    content.textContent = text;
  } else {
    renderRichText(content, text);
  }

  message.append(avatar, content);
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;

  return message;
}

function addTyping() {
  const messages = $("#chatMessages");
  const typing = document.createElement("div");

  typing.className = "message bot-message";
  typing.id = "typingIndicator";
  typing.innerHTML = `
    <div class="message-avatar">🍓</div>
    <div class="message-content">Glowberry sedang berpikir... ✨</div>
  `;

  messages.appendChild(typing);
  messages.scrollTop = messages.scrollHeight;

  return typing;
}

// Antrean pesan: setiap pertanyaan dikirim SATU per SATU dan mendapat jawabannya
// sendiri. Klik quick prompt beruntun tidak diproses paralel dan tidak dibuang.
const chatQueue = [];
let chatBusy = false;

function sendChatMessage(message) {
  const text = String(message || "").trim();
  if (!text) return;

  $("#chatInput").value = "";
  chatQueue.push(text);
  processChatQueue();
}

async function processChatQueue() {
  if (chatBusy) return;
  chatBusy = true;

  try {
    while (chatQueue.length) {
      await askGlowberry(chatQueue.shift());
    }
  } finally {
    chatBusy = false;
    $("#chatInput").focus();
  }
}

async function askGlowberry(text) {
  // Pertanyaan ditampilkan saat mulai diproses agar jawabannya tepat di bawahnya
  addMessage(text, "user");
  const typing = addTyping();

  try {
    const { response, data } = await fetchJSON(`${API}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });

    typing.remove();

    if (!response.ok || !data || !data.success) {
      addMessage(
        (data && data.error) ||
        "Aduh Kak, Glowberry sedang gangguan. Coba tanyakan lagi sebentar ya! 💗"
      );
      return;
    }

    addMessage(data.reply || "Maaf Kak, aku belum mendapatkan jawaban.");
  } catch (error) {
    typing.remove();
    console.warn("Chatbot error:", error.message);
    addMessage("Aduh Kak, sepertinya koneksi sedang terganggu. Coba tanyakan lagi sebentar ya! 💗");
  }
}

$("#chatForm").addEventListener("submit", event => {
  event.preventDefault();
  sendChatMessage($("#chatInput").value);
});

document.querySelectorAll(".quick-prompts button").forEach(button => {
  button.addEventListener("click", () => sendChatMessage(button.dataset.prompt));
});

// ===============================
// KNOWLEDGE ADMIN
// ===============================

async function loadKnowledge() {
  const container = $("#knowledgeList");
  if (!container) return;

  try {
    const { response, data } = await fetchJSON(`${API}/api/knowledge`);
    if (!response.ok || !data) throw new Error("Knowledge tidak tersedia");

    const topics = Object.keys(data.responses || {});
    const keywords = Object.keys(data.keywords || {});

    container.innerHTML = topics.length
      ? `<p class="knowledge-summary">${topics.length} topik FAQ · ${keywords.length} kata kunci</p>` +
        keywords.map(keyword =>
          `<span class="tag-item" title="Topik: ${escapeHTML(data.keywords[keyword])}">${escapeHTML(keyword)}</span>`
        ).join("")
      : "<em>Tidak ada kata kunci manual.</em>";
  } catch (error) {
    console.warn("Knowledge tidak dapat dimuat:", error.message);
    container.textContent = "Data knowledge tidak tersedia.";
  }
}

// ===============================
// WHATSAPP GATEWAY ADMIN
// ===============================

function gatewayEndpoint(path) {
  return `${gatewayUrl}${path}`;
}

function adminHeaders() {
  const token = sessionStorage.getItem("glowberryAdminToken");
  return token ? { "X-Admin-Token": token } : {};
}

function setGatewayUnavailable(message) {
  const dot = $("#statusDot");
  dot.classList.remove("ready", "waiting");
  $("#statusText").textContent = message;
  $("#qrSection").classList.add("hidden");
  $("#readySection").classList.add("hidden");
  ["#startBtn", "#stopBtn", "#resetBtn"].forEach(id => ($(id).disabled = true));
  $("#gatewayInfo").classList.remove("hidden");
}

async function loadConfig() {
  try {
    const { response, data } = await fetchJSON(`${API}/api/config`);
    gatewayUrl = response.ok && data && typeof data.waGatewayUrl === "string"
      ? data.waGatewayUrl
      : null;
  } catch {
    gatewayUrl = null;
  }
}

async function loadBotStatus() {
  if (gatewayUrl === null) {
    setGatewayUnavailable("WhatsApp Gateway tidak aktif pada deployment ini");
    return;
  }

  try {
    const { response, data } = await fetchJSON(gatewayEndpoint("/api/bot/status"));
    if (!response.ok || !data) throw new Error("Status tidak tersedia");

    ["#startBtn", "#stopBtn", "#resetBtn"].forEach(id => ($(id).disabled = false));
    $("#gatewayInfo").classList.add("hidden");

    const ready = data.isReady === true;
    const dot = $("#statusDot");
    dot.classList.toggle("ready", ready);
    dot.classList.toggle("waiting", !ready);

    let status = "Bot WhatsApp Belum Terhubung";
    if (ready) status = "Bot WhatsApp Terhubung";
    else if (data.isCleaning) status = "Membersihkan sesi...";
    else if (data.isInitializing) status = "Memulai bot, menunggu kode QR...";
    else if (data.hasQRCode) status = "Menunggu pemindaian QR";
    if (data.lastError) status += ` · ${data.lastError}`;
    $("#statusText").textContent = status;

    $("#readySection").classList.toggle("hidden", !ready);
    $("#qrSection").classList.toggle("hidden", ready || !(data.hasQRCode || data.isInitializing));
    $("#botNumberText").textContent = data.botNumber || "-";

    if (!ready && data.hasQRCode) {
      await loadQR();
    } else if (!data.hasQRCode) {
      qrLastValue = null;
      $("#qrcode").textContent = "Menunggu kode QR...";
    }
  } catch (error) {
    console.warn("Gagal mengecek status bot:", error.message);
    setGatewayUnavailable("WhatsApp Gateway tidak dapat dihubungi");
  }
}

async function loadQR() {
  try {
    const { response, data } = await fetchJSON(gatewayEndpoint("/api/bot/qr"), {
      headers: adminHeaders()
    });

    if (response.status === 401) {
      $("#qrcode").textContent = "Masukkan token admin (klik Mulai Bot) untuk melihat QR.";
      return;
    }
    if (!data || !data.qr || data.qr === qrLastValue) return;

    qrLastValue = data.qr;

    const qrContainer = $("#qrcode");
    qrContainer.innerHTML = "";

    if (window.QRCode) {
      new QRCode(qrContainer, {
        text: data.qr,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      qrContainer.textContent = "Library QR gagal dimuat. Lihat QR di terminal server.";
    }
  } catch (error) {
    console.warn("QR belum tersedia:", error.message);
  }
}

async function botAction(endpoint, button, loadingText) {
  if (gatewayUrl === null) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;

  try {
    let { response, data } = await fetchJSON(gatewayEndpoint(`/api/bot/${endpoint}`), {
      method: "POST",
      headers: adminHeaders()
    });

    if (response.status === 401) {
      const token = prompt("Masukkan ADMIN_TOKEN WhatsApp Gateway:");
      if (!token) return;
      sessionStorage.setItem("glowberryAdminToken", token.trim());
      ({ response, data } = await fetchJSON(gatewayEndpoint(`/api/bot/${endpoint}`), {
        method: "POST",
        headers: adminHeaders()
      }));
    }

    if (!response.ok || !data || data.success === false) {
      if (response.status === 401) sessionStorage.removeItem("glowberryAdminToken");
      throw new Error((data && data.error) || "Operasi bot gagal.");
    }

    alert(data.message || "Permintaan berhasil dikirim.");
    await loadBotStatus();
  } catch (error) {
    alert(error.message);
    console.warn(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

$("#startBtn").addEventListener("click", () => {
  botAction("start", $("#startBtn"), "Memulai...");
});

$("#stopBtn").addEventListener("click", () => {
  botAction("stop", $("#stopBtn"), "Menghentikan...");
});

$("#resetBtn").addEventListener("click", () => {
  if (confirm("Yakin ingin mereset sesi WhatsApp? Bot harus dipindai ulang.")) {
    botAction("reset", $("#resetBtn"), "Mereset...");
  }
});

// ===============================
// GROQ QUOTA MONITOR
// ===============================

function percent(remaining, limit) {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

async function loadGroqQuota(fresh = false) {
  try {
    const { response, data } = await fetchJSON(
      `${API}/api/groq/quota${fresh ? "?fresh=true" : ""}`
    );
    if (!response.ok || !data) throw new Error("Kuota tidak tersedia");

    const fmt = value => (value === null || value === undefined ? "-" : Number(value).toLocaleString("id-ID"));

    $("#groqReqRemaining").textContent = data.remainingRequests !== null && data.remainingRequests !== undefined
      ? `${fmt(data.remainingRequests)} / ${fmt(data.limitRequests)}`
      : "-";
    $("#groqTokenRemaining").textContent = data.remainingTokens !== null && data.remainingTokens !== undefined
      ? `${fmt(data.remainingTokens)} / ${fmt(data.limitTokens)}`
      : "-";

    $("#groqModelName").textContent = data.configured
      ? data.model || "Model dari konfigurasi server"
      : "Groq belum dikonfigurasi";

    $("#groqReqReset").textContent = data.resetRequests
      ? `Reset: ${data.resetRequests}`
      : fresh ? "Informasi reset tidak tersedia" : "Klik Cek Kuota untuk data terbaru";

    $("#groqLastChecked").textContent =
      "Pembaruan: " + new Date().toLocaleTimeString("id-ID");

    const reqPct = percent(Number(data.remainingRequests), Number(data.limitRequests));
    const tokPct = percent(Number(data.remainingTokens), Number(data.limitTokens));
    if (reqPct !== null) $("#groqReqBar").style.width = `${reqPct}%`;
    if (tokPct !== null) $("#groqTokenBar").style.width = `${tokPct}%`;
  } catch (error) {
    console.warn("Kuota Groq tidak tersedia:", error.message);
    $("#groqModelName").textContent = "Tidak tersedia";
  }
}

$("#refreshQuotaBtn").addEventListener("click", () => loadGroqQuota(true));

// ===============================
// MOBILE NAVIGATION
// ===============================

$("#mobileMenu")?.addEventListener("click", () => {
  const open = $(".nav-links").classList.toggle("open");
  $("#mobileMenu").setAttribute("aria-expanded", String(open));
});

document.querySelectorAll(".nav-links a").forEach(link => {
  link.addEventListener("click", () => {
    $(".nav-links").classList.remove("open");
    $("#mobileMenu")?.setAttribute("aria-expanded", "false");
  });
});

// ===============================
// INITIALIZE WEBSITE
// ===============================

async function initializeGlowberry() {
  await loadConfig();

  await Promise.allSettled([
    loadProducts(),
    loadKnowledge(),
    loadBotStatus(),
    loadGroqQuota()
  ]);

  // Polling status hanya jika gateway tersedia
  if (gatewayUrl !== null) {
    botStatusTimer = setInterval(loadBotStatus, 10000);
  }
}

document.addEventListener("DOMContentLoaded", initializeGlowberry);
