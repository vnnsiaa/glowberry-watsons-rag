# Glowberry: Watsons RAG Chatbot

Website katalog 30 produk Watsons (Shopee) dengan asisten AI **Glowberry**.
Jawaban chatbot dihasilkan **Groq LLM** dan berbasis **RAG**: setiap pertanyaan
mencari produk yang relevan di `data/products.csv` serta FAQ di `knowledge.json`,
lalu hanya data itu yang diberikan ke model sebagai konteks.

- Website: https://glowberry-watsons-rag.vercel.app
- Repository: https://github.com/vnnsiaa/glowberry-watsons-rag

## Arsitektur

```
                 ┌─────────────────────────── Vercel ───────────────────────────┐
 Browser ──────▶ │ public/ (HTML, CSS, JS statis)                               │
                 │ api/products.js  api/chat.js  api/knowledge.js               │
                 │ api/health.js    api/config.js  api/groq/quota.js            │
                 └──────────────┬───────────────────────────────────────────────┘
                                │ lib/chatbot.js + lib/rag.js (dipakai bersama)
                                ▼
                             Groq API
                                ▲
 WhatsApp ◀──▶ whatsapp-web.js ─┘
               server-v2.js (Express, proses Node.js PERSISTEN di komputer lokal)
```

| Komponen | Lokasi | Hosting |
|---|---|---|
| Frontend | `public/` | Vercel (static) |
| API katalog & chatbot | `api/*.js` | Vercel Functions |
| Logika chatbot + RAG | `lib/chatbot.js`, `lib/rag.js` | dipakai Vercel & server-v2 |
| WhatsApp Gateway | `server-v2.js` | Lokal (`npm start`). **Tidak bisa di Vercel**: perlu proses yang hidup terus + Chromium |

`server-v2.js` juga melayani website dan semua endpoint API, jadi `npm start`
menjalankan versi lengkap (website + chatbot + WhatsApp) di satu mesin.

### Alur chatbot (`lib/chatbot.js`)
1. Sapaan / terima kasih → jawaban langsung.
2. Pertanyaan layanan (cara beli, ongkir, pembayaran) tanpa produk → jawaban dari `knowledge.json`.
3. Retrieval produk (`lib/rag.js`): skor nama/merek, kategori, dan sinonim; urut harga untuk "termurah/termahal".
4. Groq dipanggil dengan konteks katalog + FAQ. Prompt melarang mengarang produk, harga, dan URL.
5. Model utama (`GROQ_MODEL`) kena rate limit → langsung pindah ke `GROQ_FALLBACK_MODELS`
   (model yang kena 429 dilewati sementara sesuai waktu tunggu dari Groq).
6. Semua model gagal / API key belum diset → jawaban fallback dari data katalog asli (bukan error).

Kolom `kategori` di CSV kosong, sehingga kategori diturunkan dari nama produk
(`CATEGORY_RULES` di `lib/rag.js`): Perawatan Wajah, Tabir Surya, Perawatan Rambut,
Perawatan Tubuh, Perawatan Mulut, Kewanitaan, Kesehatan.

## Instalasi lokal

```bash
npm install
cp .env.example .env     # lalu isi GROQ_API_KEY
npm start                # http://localhost:3001
```

## Environment variable

| Variabel | Wajib | Keterangan |
|---|---|---|
| `GROQ_API_KEY` | ya | API key Groq. Hanya dibaca server; tidak pernah dikirim ke browser. |
| `GROQ_MODEL` | tidak | Default `qwen/qwen3.8-27b` |
| `GROQ_FALLBACK_MODELS` | tidak | Default `openai/gpt-oss-120b,openai/gpt-oss-20b` |
| `GROQ_MAX_TOKENS` | tidak | Default `1024` |
| `GROQ_TIMEOUT_MS` | tidak | Default `20000` |
| `RAG_TOP_K` | tidak | Jumlah produk maksimal dalam konteks, default `8` |
| `PORT` | tidak | Port server-v2, default `3001` |
| `ADMIN_TOKEN` | ya, jika gateway publik | Melindungi `/api/bot/start|stop|reset|qr` (header `X-Admin-Token`) |
| `ALLOWED_ORIGINS` | disarankan | Origin yang boleh memanggil gateway, mis. URL Vercel |
| `AUTO_START_BOT` | tidak | `true` = bot WhatsApp langsung dimulai |
| `WA_SESSION_DIR`, `WA_CACHE_DIR` | tidak | Lokasi sesi & cache WhatsApp |
| `PUPPETEER_EXECUTABLE_PATH` | tidak | Path Chrome/Chromium sistem |
| `WA_GATEWAY_URL` | tidak (Vercel) | URL publik server-v2 agar dashboard di Vercel bisa mengontrol bot |

Catatan: tier gratis Groq untuk `qwen/qwen3.8-27b` hanya 1000 output token/menit,
sehingga saat demo yang ramai jawaban akan otomatis memakai model cadangan.

## Testing

```bash
npm run check          # syntax JS, validasi JSON, encoding (BOM/mojibake), scan secret & file sensitif
npm test               # 35 unit/integration test (RAG, chatbot dengan Groq tiruan, API Vercel, server-v2)
npm start              # lalu di terminal lain:
npm run test:live      # end-to-end dengan Groq asli; jawaban dicek terhadap harga & URL katalog
npm run test:browser   # Puppeteer desktop + mobile; screenshot ke test-results/
```

`test:live` dan `test:browser` menerima URL, mis. `node scripts/live-check.js https://glowberry-watsons-rag.vercel.app`.

## Deployment Vercel

`vercel.json` memakai Vercel Functions modern:
- `outputDirectory: public` untuk file statis
- `api/**/*.js` otomatis menjadi function di `/api/<nama>`; `data/products.csv` dan `knowledge.json` ikut dibundel (`includeFiles`)
- `installCommand` memakai `--ignore-scripts` agar Chromium milik whatsapp-web.js tidak ikut diunduh
- rewrite `/api/<nama>.js` → `/api/<nama>` untuk kompatibilitas URL lama

Langkah:
1. Vercel → Project → Settings → Environment Variables: isi `GROQ_API_KEY` (dan `GROQ_MODEL` bila perlu) untuk Production & Preview.
2. Push ke GitHub (auto-deploy) **atau** `npx vercel --prod`.
3. Verifikasi: `node scripts/live-check.js https://glowberry-watsons-rag.vercel.app`.

## WhatsApp Gateway

WhatsApp Web.js menjalankan Chromium dan menyimpan sesi login, jadi butuh proses
Node.js yang hidup terus. **Jangan** dijalankan sebagai Vercel Function.

### Menjalankan gateway (lokal)
```bash
npm start
```
Buka http://localhost:3001 → **Admin Dashboard** → **Mulai Bot** → pindai QR dari
WhatsApp (Perangkat Tertaut → Tautkan Perangkat). Setelah terhubung, kirim pesan
pribadi ke nomor bot (pesan grup & status diabaikan).

Agar dashboard di Vercel juga bisa mengontrol bot lokal, buka tunnel
(mis. `cloudflared tunnel --url http://localhost:3001`), lalu set di Vercel:
`WA_GATEWAY_URL=<url tunnel>`; di `.env` lokal set `ADMIN_TOKEN` dan
`ALLOWED_ORIGINS=https://glowberry-watsons-rag.vercel.app`.

### Endpoint gateway
| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/bot/status` | `isReady`, `isInitializing`, `hasQRCode`, nomor bot (disamarkan), `lastError` |
| GET | `/api/bot/qr` | String QR (butuh token admin) |
| POST | `/api/bot/start` | Memulai bot (non-blocking) |
| POST | `/api/bot/stop` | Menghentikan bot & menutup Chromium |
| POST | `/api/bot/reset` | Logout: hapus sesi & cache, perlu scan QR ulang |

## Keamanan

- `.env*` (kecuali `.env.example`), `.vercel/`, `.wwebjs_auth/`, `.wwebjs_cache/` di-ignore Git; `npm run check` memeriksanya.
- API key hanya dipakai di server. `/api/config` dan `/api/health` tidak mengembalikan secret.
- Jawaban AI dirender sebagai teks; hanya `**tebal**` dan link `https://shopee.co.id` yang diubah menjadi elemen.
- Semua link pembelian divalidasi harus `https://*.shopee.co.id`.
