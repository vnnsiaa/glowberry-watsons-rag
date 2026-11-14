const { getChatbot } = require("../lib/chatbot");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const bot = getChatbot();

  return res.status(200).json({
    success: true,
    status: "ok",
    runtime: "vercel",
    products: bot.ragEngine.loadData().length,
    knowledgeTopics: Object.keys(bot.loadKnowledge().responses || {}).length,
    groqConfigured: bot.isConfigured(),
    model: bot.primaryModel(),
    whatsappGateway: Boolean(process.env.WA_GATEWAY_URL)
  });
};
