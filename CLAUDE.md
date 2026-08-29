# quizzy

**Questo progetto è `quizzy` (repo GitHub: `gianca-oss/Quizzy`). NON è testy.**

## Cos'è
Assistente per quiz basato su OCR + RAG: l'utente fotografa le domande di un esame,
il sistema le estrae (OCR via Claude), cerca le risposte in un corpus del corso e le
restituisce con la fonte. PWA con service worker; deploy su Railway (auto-deploy da
`main`).

## Struttura
- `api/` — la logica: `analyze-railway.js` (handler), `question-bank.js` (lookup a 3
  tier), `response-builder.js` (prompt unico + parser), `claude-client.js`, `search.js`,
  `data-loader.js`.
- `data/processed/<corso>/` — chunks, embeddings, metadata e (dove presente)
  `question-bank.json` per ogni corso.
- `scripts/` — preprocessing PDF, embeddings, `normalize-bank.js`, eval retrieval.
- `tests/` — regression suite (`npm test`, node:test).
- Il corso attivo si sceglie a runtime con la env var `COURSE_NAME` (vedi
  `api/data-loader.js`), impostata su Railway. Nessun default hardcoded.

## Da non confondere
Esiste un progetto separato `testy` (`~/GitHub/testy`, repo `gianca-oss/testy`,
`emba-quiz`): è un quiz statico di autovalutazione, senza `api/` né RAG. Sono due app
diverse in due repo diversi — l'unico legame è che trattano lo stesso esame
(Organizzazione e Lavoro). Se il lavoro è un quiz statico in `public/index.html` senza
backend AI, sei nella cartella sbagliata: quello è testy.
