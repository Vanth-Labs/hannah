// tests/setup.js — corre ANTES de importar cualquier módulo (jest setupFiles).
// Aísla los tests de los datos reales: memoria en RAM y sin llamadas a Ollama.
process.env.MEMORY_DB_PATH = ':memory:';   // no tocar data/memory.db
process.env.MEMORY_RECALL = 'false';       // no disparar embeddings al LLM
