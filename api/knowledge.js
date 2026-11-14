const { getChatbot } = require("../lib/chatbot");

module.exports = (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const knowledge = getChatbot().loadKnowledge();
    return res.status(200).json({ success: true, ...knowledge });
  } catch (error) {
    console.error("Knowledge API error:", error);
    return res.status(500).json({ success: false, error: "Gagal memuat basis pengetahuan." });
  }
};
