# Quizzy

Applicazione per analizzare quiz con AI - Ver. 3.1

Quiz analyzer con ricerca semantica e preprocessing di documenti PDF.

## Stack

- Node.js >= 18
- Express (server)
- pdf-parse / pdfjs-dist (estrazione PDF)
- OpenAI embeddings (ricerca semantica)

## Setup

```bash
npm install
```

## Avvio server

```bash
npm start
```

Il server espone:
- `GET /` — UI (da `public/index.html`)
- `GET|POST /api/analyze` — endpoint di analisi quiz
- `GET /health` — health check

## Preprocessing corsi

1. Metti il PDF in `data/source/<nome-corso>/source.pdf`
2. Estrai e chunkizza il contenuto:
   ```bash
   npm run preprocess -- <nome-corso>
   ```
3. (Opzionale) Pulisci i chunks da artefatti OCR:
   ```bash
   npm run clean-chunks -- <nome-corso>
   ```
4. Genera gli embeddings:
   ```bash
   OPENAI_API_KEY=sk-... npm run embeddings -- <nome-corso>
   ```

Output in `data/processed/<nome-corso>/`.

## Struttura

```
api/        Handler API (Railway)
data/       PDF sorgente e chunks processati
public/     Frontend statico
scripts/    Script di preprocessing e utility
server.js   Entry point Express
```
