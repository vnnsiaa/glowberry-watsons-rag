
const API = "";
let allProducts = [];
let activeCategory = "all";
let botStatusTimer = null;
let qrLastValue = null;

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

function rupiah(value) {
  const number = Number(String(value || "0").replace(/[^\d]/g, ""));
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(number);
}

function numericPrice(value) {
  return Number(String(value || "0").replace(/[^\d]/g, "")) || 0;
}

// ===============================
// LOAD PRODUK DARI BACKEND RAG
// ===============================

async function loadProducts() {
  const grid = $("#productGrid");

  try {
    const response = await fetch(`${API}/api/products`);
    if (!response.ok) throw new Error("Gagal mengambil data produk");

    const result = await response.json();
    allProducts = Array.isArray(result.products) ? result.products : [];

    renderCategories();
    renderProducts();

    // Tabel admin
    const tbody = $("#productsBody");
    if (tbody) {
      tbody.innerHTML = allProducts.map(product => `
        <tr>
          <td>${escapeHTML(product.nama)}</td>
          <td>${escapeHTML(product.harga)}</td>
          <td><a href="${escapeHTML(product.href)}" target="_blank" rel="noopener">Buka Shopee ↗</a></td>
        </tr>
      `).join("");
    }

  } catch (error) {
    console.error("Gagal memuat produk:", error);
    grid.innerHTML = `
      <div class="loading-products">
        Produk belum dapat dimuat. Pastikan backend Glowberry aktif.
      </div>
    `;
    $("#productCount").textContent = "Gagal memuat produk";
  }
}

// ===============================
// KATEGORI PRODUK
// ===============================

function renderCategories() {
  const container = $("#categoryFilters");
  if (!container) return;

  const categories = [...new Set(
    allProducts.map(p => p.kategori).filter(Boolean)
  )];

  container.innerHTML = `
    <button class="filter-chip ${activeCategory === "all" ? "active" : ""}"
      data-category="all">All Products</button>
    ${categories.map(category => `
      <button class="filter-chip ${activeCategory === category ? "active" : ""}"
        data-category="${escapeHTML(category)}">
        ${escapeHTML(category)}
      </button>
    `).join("")}
  `;

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
  const sort = $("#sortProducts")?.value || "default";

  let products = allProducts.filter(product => {
    const searchable = [
      product.nama,
      product.kategori,
      product.deskripsi
    ].join(" ").toLowerCase();

    const matchesSearch = searchable.includes(search);
    const matchesCategory =
      activeCategory === "all" ||
      product.kategori === activeCategory;

    return matchesSearch && matchesCategory;
  });

  if (sort === "low") {
    products.sort((a, b) => numericPrice(a.harga) - numericPrice(b.harga));
  } else if (sort === "high") {
    products.sort((a, b) => numericPrice(b.harga) - numericPrice(a.harga));
  } else if (sort === "name") {
    products.sort((a, b) => a.nama.localeCompare(b.nama));
  }

  $("#productCount").textContent =
    `${products.length} produk ditemukan`;

  $("#emptyProducts").classList.toggle("hidden", products.length !== 0);

  if (products.length === 0) {
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = products.map((product, index) => {
    const image = product.gambar || "";
    const href = product.href || "#";

    return `
      <article class="product-card">
        <div class="product-image">
          <span class="product-tag">✿ Glowberry Pick</span>
          <img
            src="${escapeHTML(image)}"
            alt="${escapeHTML(product.nama)}"
            loading="lazy"
            onerror="this.style.display='none'"
          >
        </div>

        <div class="product-info">
          <div class="product-category">
            ${escapeHTML(product.kategori || "Beauty & Care")}
          </div>

          <div class="product-name">
            ${escapeHTML(product.nama)}
          </div>

          <div class="product-price">
            ${rupiah(product.harga)}
          </div>

          <div class="product-actions">
            <a href="${escapeHTML(href)}"
              target="_blank" rel="noopener"
              class="buy-link">
              Beli di Shopee ↗
            </a>
          </div>
        </div>
      </article>
    `;
  }).join("");
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

function addMessage(text, type = "bot") {
  const messages = $("#chatMessages");
  const message = document.createElement("div");

  message.className =
    type === "user"
      ? "message user-message"
      : "message bot-message";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = type === "user" ? "♡" : "🍓";

  const content = document.createElement("div");
  content.className = "message-content";

  // Text aman, tidak mengeksekusi HTML dari jawaban AI.
  content.textContent = text;

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

async function sendChatMessage(message) {
  const text = message.trim();
  if (!text) return;

  addMessage(text, "user");

  $("#chatInput").value = "";
  $("#sendChat").disabled = true;

  const typing = addTyping();

  try {
    const response = await fetch(`${API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: text })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || "Chatbot tidak dapat merespons.");
    }

    typing.remove();
    addMessage(result.reply || "Maaf Kak, aku belum mendapatkan jawaban.");

  } catch (error) {
    typing.remove();
    console.error("Chatbot error:", error);

    addMessage(
      "Aduh Kak, sepertinya koneksi sedang terganggu. Coba tanyakan lagi sebentar ya! 💗"
    );
  } finally {
    $("#sendChat").disabled = false;
    $("#chatInput").focus();
  }
}

$("#chatForm").addEventListener("submit", event => {
  event.preventDefault();
  sendChatMessage($("#chatInput").value);
});

document.querySelectorAll(".quick-prompts button").forEach(button => {
  button.addEventListener("click", () => {
    sendChatMessage(button.dataset.prompt);
  });
});

// ===============================
// KNOWLEDGE ADMIN
// ===============================

async function loadKnowledge() {
  try {
    const response = await fetch(`${API}/api/knowledge`);
    const data = await response.json();

    const container = $("#knowledgeList");
    if (!container) return;

    const keywords = Object.keys(data.keywords || {});

    container.innerHTML = keywords.length
      ? keywords.map(keyword =>
          `<span class="tag-item">${escapeHTML(keyword)}</span>`
        ).join("")
      : "<em>Tidak ada kata kunci manual.</em>";

  } catch (error) {
    console.warn("Knowledge tidak dapat dimuat:", error);
    $("#knowledgeList").textContent = "Data knowledge tidak tersedia.";
  }
}

// ===============================
// WHATSAPP GATEWAY ADMIN
// ===============================

async function loadBotStatus() {
  try {
    const response = await fetch(`${API}/api/bot/status`);
    const data = await response.json();

    const status = String(
      data.status || data.state || ""
    ).toLowerCase();

    const ready = data.isReady === true ||
      data.ready === true ||
      status === "ready" ||
      status === "connected";

    const dot = $("#statusDot");
    dot.classList.toggle("ready", ready);
    dot.classList.toggle("waiting", !ready);

    $("#statusText").textContent = ready
      ? "Bot WhatsApp Terhubung"
      : "Bot WhatsApp Belum Terhubung";

    $("#readySection").classList.toggle("hidden", !ready);
    $("#qrSection").classList.toggle("hidden", ready);

    if (data.number || data.phoneNumber) {
      $("#botNumberText").textContent =
        data.number || data.phoneNumber;
    }

    if (!ready) {
      await loadQR();
    }

  } catch (error) {
    console.warn("Gagal mengecek status bot:", error);
    $("#statusText").textContent = "Status bot tidak tersedia";
  }
}

async function loadQR() {
  try {
    const response = await fetch(`${API}/api/bot/qr`);
    const data = await response.json();

    if (!data.qr) return;

    if (data.qr === qrLastValue) return;

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
      qrContainer.textContent = data.qr;
    }

  } catch (error) {
    console.warn("QR belum tersedia:", error);
  }
}

async function botAction(endpoint, button, loadingText) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;

  try {
    const response = await fetch(`${API}/api/bot/${endpoint}`, {
      method: "POST"
    });

    const result = await response.json();

    if (!response.ok || result.success === false) {
      throw new Error(result.error || "Operasi bot gagal.");
    }

    alert(result.message || "Permintaan berhasil dikirim.");
    await loadBotStatus();

  } catch (error) {
    alert(error.message);
    console.error(error);
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
  if (confirm("Yakin ingin mereset sesi WhatsApp?")) {
    botAction("reset", $("#resetBtn"), "Mereset...");
  }
});

// ===============================
// GROQ QUOTA MONITOR
// ===============================

async function loadGroqQuota(fresh = false) {
  try {
    const response = await fetch(
      `${API}/api/groq/quota${fresh ? "?fresh=true" : ""}`
    );

    const data = await response.json();

    $("#groqReqRemaining").textContent =
      data.remainingRequests ?? data.remaining_requests ?? "-";

    $("#groqTokenRemaining").textContent =
      data.remainingTokens ?? data.remaining_tokens ?? "-";

    $("#groqModelName").textContent =
      data.model || data.modelName ||
      "Model dari konfigurasi server";

    $("#groqReqReset").textContent =
      data.resetRequests || data.reset_requests ||
      "Informasi reset tidak tersedia";

    $("#groqLastChecked").textContent =
      "Pembaruan: " + new Date().toLocaleTimeString("id-ID");

    const requestRemaining =
      Number(data.remainingRequests ?? data.remaining_requests);

    const tokenRemaining =
      Number(data.remainingTokens ?? data.remaining_tokens);

    if (Number.isFinite(requestRemaining)) {
      $("#groqReqBar").style.width =
        `${Math.max(0, Math.min(100, requestRemaining))}%`;
    }

    if (Number.isFinite(tokenRemaining)) {
      $("#groqTokenBar").style.width =
        `${Math.max(0, Math.min(100, tokenRemaining))}%`;
    }

  } catch (error) {
    console.warn("Kuota Groq tidak tersedia:", error);
    $("#groqModelName").textContent = "Tidak tersedia";
  }
}

$("#refreshQuotaBtn").addEventListener("click", () => {
  loadGroqQuota(true);
});

// ===============================
// MOBILE NAVIGATION
// ===============================

$("#mobileMenu")?.addEventListener("click", () => {
  $(".nav-links").classList.toggle("open");
});

document.querySelectorAll(".nav-links a").forEach(link => {
  link.addEventListener("click", () => {
    $(".nav-links").classList.remove("open");
  });
});

// ===============================
// INITIALIZE WEBSITE
// ===============================

async function initializeGlowberry() {
  console.log("🍓 Glowberry website initialized");

  await Promise.allSettled([
    loadProducts(),
    loadKnowledge(),
    loadBotStatus(),
    loadGroqQuota()
  ]);

  botStatusTimer = setInterval(loadBotStatus, 10000);
}

document.addEventListener("DOMContentLoaded", initializeGlowberry);
