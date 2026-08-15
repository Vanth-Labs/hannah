// src/api/handler.js
// Envoltura de handlers de la API: centraliza el try/catch -> 500 { error: slug, message }
// que estaba copiado en los 10 endpoints. El handler solo escribe la respuesta feliz.
export const handler = (slug, fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (error) {
    if (res.headersSent) return;
    res.status(500).json({ error: slug, message: error.message });
  }
};
