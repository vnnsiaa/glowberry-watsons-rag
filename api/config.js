// Konfigurasi publik untuk frontend. Jangan pernah mengembalikan secret di sini.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const gateway = (process.env.WA_GATEWAY_URL || "").trim().replace(/\/+$/, "");

  return res.status(200).json({
    success: true,
    runtime: "vercel",
    // URL server WhatsApp Gateway (server-v2.js) yang berjalan terpisah, jika ada
    waGatewayUrl: /^https?:\/\//.test(gateway) ? gateway : null
  });
};
