const { getChatbot } = require("../lib/chatbot");

const MAX_MESSAGE_LENGTH = 1000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ success: false, error: "Format JSON tidak valid." });
    }
  }

  const message = body && body.message;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ success: false, error: "Pesan tidak boleh kosong." });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(413).json({
      success: false,
      error: `Pesan terlalu panjang (maksimal ${MAX_MESSAGE_LENGTH} karakter).`
    });
  }

  try {
    const result = await getChatbot().reply(message);

    return res.status(200).json({
      success: true,
      reply: result.reply,
      source: result.source
    });
  } catch (error) {
    console.error("Chat API Error:", error);
    return res.status(500).json({
      success: false,
      error: "Maaf, Glowberry sedang mengalami gangguan."
    });
  }
};
