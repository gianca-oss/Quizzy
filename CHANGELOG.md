# Quizzy - Changelog e Riepilogo Deploy

## Versione 3.1.0 (2 Febbraio 2026)
**Ricerca Semantica + Miglioramento Qualità Chunks**

### Nuove Funzionalità
- **Ricerca semantica con OpenAI Embeddings**
  - Modello: `text-embedding-3-small` (512 dimensioni)
  - Cosine similarity per trovare chunks semanticamente simili
  - Fallback automatico a ricerca keyword se OpenAI non disponibile

- **Ricerca ibrida**
  - Prima prova ricerca semantica
  - Se fallisce, usa ricerca keyword come backup
  - Metadata nella risposta indica il metodo usato

### Miglioramenti Qualità
- **Correzione errori OCR**: 384 chunks corretti
  - Parole spezzate riparate (es. `"informa zione"` → `"informazione"`)
  - Spazi errati rimossi

- **Marker strutturali rimossi**: 224 chunks puliti
  - Eliminati `[HEADER]`, `[FIG]`, `[TAB]`, `[TABELLA]`
  - Headers convertiti in markdown (`## `, `### `)

- **Keywords migliorate**
  - Estratti termini tecnici del corso
  - Esempi: `knowledge`, `management`, `strategia`, `innovazione`, `business`

### File Aggiunti
- `preprocess-embeddings.js` - Genera embeddings OpenAI
- `clean-chunks.js` - Pulizia post-processing dei chunks

### Configurazione Richiesta
```bash
# Railway Variables
OPENAI_API_KEY=sk-proj-...
```

### Costi Stimati
- Preprocessing embeddings: ~$0.003 (una tantum)
- Runtime per domanda: ~$0.00001

---

## Versione 3.0.0 (1 Febbraio 2026)
**Migrazione da Vercel a Railway**

### Motivazione
- Timeout Vercel (10s) insufficiente per Opus
- Railway offre timeout fino a 5 minuti

### Architettura
```
Frontend (index.html)
    ↓
Railway (server.js + Express)
    ↓
Claude API (Sonnet per estrazione, Opus per analisi)
    ↓
GitHub Raw (chunks PDF)
```

### Modelli Utilizzati
| Step | Modello | Scopo |
|------|---------|-------|
| Estrazione domande | `claude-sonnet-4-20250514` | Legge immagine quiz |
| Analisi risposte | `claude-opus-4-20250514` | Cerca nel PDF e risponde |

### Funzionalità
- Estrazione domande da immagini quiz
- Ricerca risposte nel materiale del corso (PDF preprocessato)
- Citazioni con numero di pagina
- Indicatori fonte: 📚 CITATO, 🔍 VERIFICATO, ⚠️ AI
- Numerazione continua tra immagini multiple

### Configurazione Railway
```bash
# Variables
ANTHROPIC_API_KEY_EVO=sk-ant-...
PORT=3000

# Build
npm install

# Start
npm start
```

---

## Versione 2.x (Gennaio 2026)
**Preprocessing PDF Avanzato**

### Sistema di Chunking
- Chunk size: 1500 caratteri
- Overlap: 300 caratteri
- 389 chunks totali da 149 pagine

### Indicizzazione
- Keywords estratte per chunk
- Mapping pagina → chunks
- Ricerca per parole chiave

### File Generati
```
data/processed/strategia-internazionalizzazione/
├── chunks_0.json ... chunks_7.json (389 chunks)
├── embeddings.json (3 MB, con vettori 512-dim)
├── metadata.json
└── search-index.json
```

---

## Versione 1.x (Dicembre 2025)
**MVP su Vercel**

### Funzionalità Base
- Upload immagine quiz
- Estrazione domande con Claude
- Risposta basata su conoscenze AI (senza PDF)

### Limitazioni
- Timeout 10 secondi
- Nessuna ricerca nel materiale
- Solo Sonnet disponibile

---

## Stack Tecnologico

| Componente | Tecnologia |
|------------|------------|
| Backend | Node.js + Express |
| Hosting | Railway |
| AI Extraction | Claude Sonnet 4 |
| AI Analysis | Claude Opus 4 |
| Embeddings | OpenAI text-embedding-3-small |
| PDF Processing | pdf-parse |
| Frontend | HTML/CSS/JS vanilla |

---

## Comandi Utili

```bash
# Preprocessing PDF (se cambia il materiale)
npm run preprocess

# Generare embeddings (richiede OPENAI_API_KEY)
npm run embeddings

# Pulire chunks esistenti
node clean-chunks.js

# Avviare server locale
npm start
```

---

## Prossimi Miglioramenti Possibili

1. **Vector Database** - Pinecone/Supabase per scalabilità
2. **Multi-corso** - Supporto per più PDF
3. **Caching risposte** - Evitare ricalcolo per domande simili
4. **UI migliorata** - Progress bar, preview chunks trovati
5. **Batch processing** - Analisi multiple immagini in parallelo
