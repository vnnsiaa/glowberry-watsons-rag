const { getChatbot } = require("../lib/chatbot");

module.exports = (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const rag = getChatbot().ragEngine;
    const products = rag.loadData();

    if (!products.length) {
      return res.status(503).json({ success: false, error: "Katalog produk belum tersedia." });
    }

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      success: true,
      total: products.length,
      categories: rag.getCategories(),
      products
    });
  } catch (error) {
    console.error("Products API error:", error);
    return res.status(500).json({ success: false, error: "Gagal memuat katalog produk." });
  }
};
