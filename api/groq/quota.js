const { getChatbot } = require("../../lib/chatbot");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const bot = getChatbot();
    // Ping ke Groq hanya bila diminta (?fresh=true) agar tidak memboroskan kuota
    const quota = req.query && req.query.fresh === "true"
      ? await bot.refreshQuota()
      : bot.getQuota();

    return res.status(200).json({ success: true, ...quota });
  } catch (error) {
    console.error("Quota API error:", error);
    return res.status(500).json({ success: false, error: "Gagal memeriksa kuota Groq." });
  }
};
