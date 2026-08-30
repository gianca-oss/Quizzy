function buildContextFromSearchResults(searchResults, startNumber) {
    let contextPerQuestion = '';
    let semanticCount = 0;
    let keywordCount = 0;

    searchResults.forEach((result, index) => {
        const questionNum = startNumber + index;

        if (result.searchMethod === 'semantic') semanticCount++;
        else keywordCount++;

        if (result.matches.length > 0) {
            contextPerQuestion += `\nDOMANDA ${questionNum} - CONTESTO (${result.searchMethod}):\n`;
            result.matches.slice(0, 4).forEach(match => {
                const section = match.chunk.section || `chunk ${match.chunk.id}`;
                contextPerQuestion += `[Sez. ${section}] ${match.chunk.text.substring(0, 1500)}\n`;
            });
        } else {
            contextPerQuestion += `\nDOMANDA ${questionNum} - NO CONTESTO\n`;
        }
    });

    return { contextPerQuestion, semanticCount, keywordCount };
}

function buildExtractionPrompt() {
    return `Sei un sistema OCR: il tuo unico compito è ESTRARRE il testo dall'immagine.
NON interpretare, NON correggere, NON riformulare, NON tradurre, NON abbreviare.
Copia il testo VERBATIM, esattamente come appare nell'immagine, parola per parola.

Rispondi SOLO con JSON valido — niente testo prima/dopo, niente markdown, niente \`\`\`.

Schema esatto:
{
  "questions": [
    {
      "text": "testo COMPLETO e VERBATIM della domanda",
      "options": {
        "A": "testo VERBATIM dell'opzione A",
        "B": "testo VERBATIM dell'opzione B",
        "C": "testo VERBATIM dell'opzione C",
        "D": "testo VERBATIM dell'opzione D (se presente)"
      }
    }
  ]
}

REGOLE CRITICHE:
1. Una entry "questions" per OGNI domanda visibile. Anche quelle parziali alla fine.
2. Per ogni domanda, includi TUTTE le opzioni presenti (A, B, C, D, anche E se c'è).
3. Trascrivi ogni opzione INTEGRALMENTE: non tagliare, non parafrasare, non "ottimizzare".
4. Se un'opzione contiene numeri, simboli, parentesi, virgolette, formule: copiali esattamente.
5. Se NON sei sicuro che una stringa sia un'opzione o parte della domanda, includila comunque nel campo dove appare visivamente nell'immagine.
6. NON aggiungere mai commenti, spiegazioni o note. Solo il JSON.
7. Se l'immagine è illeggibile per una sezione, scrivi "[illeggibile]" come valore, mai vuoto.`;
}

// Strip a leading "N." / "N)" question number from OCR'd text so we never
// render a double number ("5. 5. ..."). Requires trailing whitespace so that
// decimals (3.5) and years (1990) are left intact.
const stripLeadingNum = (text) => (text || '').replace(/^\s*\d{1,3}[.)]\s+/, '');

// Per-chunk cap by relevance rank. The top hit is where the answer almost
// always is, so it gets the full text (p90 of the corpus ≈ 4.9k chars);
// rank 2-3 are weak corroboration and stay short. This concentrates the
// token budget on the evidence that actually decides the answer instead of
// truncating everything at 1500 like before.
const CHUNK_CAP_BY_RANK = [6000, 4000, 1500, 1500];
const DEFAULT_CHUNK_CAP = 1500;
// Global ceiling, sized on the previous worst case (20 questions x 4 chunks
// x 1500 chars) so a full quiz is never more expensive than it used to be.
const CONTEXT_BUDGET_CHARS = 120000;

// Section labels come from the PDF's table of contents and often carry the
// page number glued to the end ("...fornitore88"). Strip it for readability.
const cleanSection = (section) => (section || '').replace(/(\D)\d{1,3}$/, '$1').trim();

/**
 * Build the RAG context for a set of questions.
 *
 * Each retrieved chunk is emitted ONCE in a numbered library ([M1], [M2]...)
 * and questions reference it by id. On a themed quiz many questions retrieve
 * the same chunks, so this removes a large amount of duplicated text — and
 * the tokens saved are spent on giving the model the FULL chunk instead of
 * the first 1500 characters (which used to discard ~54% of the material).
 *
 * items: [{ num, result }] where result is a hybridSearch result.
 * Returns { context, stats }.
 */
function buildRagContextWithStats(items) {
    // 1. Deduplicate, remembering the best rank/similarity each chunk reached.
    const entries = new Map();
    items.forEach(({ num, result }) => {
        (result?.matches || []).forEach((match, rank) => {
            const chunk = match.chunk || {};
            const key = chunk.id || `${chunk.section || ''}::${(chunk.text || '').slice(0, 60)}`;
            const existing = entries.get(key);
            if (existing) {
                existing.bestRank = Math.min(existing.bestRank, rank);
                existing.bestSim = Math.max(existing.bestSim, match.similarity || 0);
                existing.questions.add(num);
            } else {
                entries.set(key, {
                    chunk,
                    bestRank: rank,
                    bestSim: match.similarity || 0,
                    questions: new Set([num])
                });
            }
        });
    });

    // 2. Most important first: chunks that were someone's top hit, then by
    //    similarity. Budget exhaustion therefore drops the weakest evidence.
    const ranked = [...entries.values()].sort((a, b) =>
        a.bestRank - b.bestRank || b.bestSim - a.bestSim
    );

    // 3. Fill the budget, assigning a stable [M#] id to what fits.
    const idByKey = new Map();
    let library = '';
    let usedChars = 0;
    let dropped = 0;

    ranked.forEach((entry) => {
        const cap = CHUNK_CAP_BY_RANK[entry.bestRank] ?? DEFAULT_CHUNK_CAP;
        const text = (entry.chunk.text || '').slice(0, cap);
        if (usedChars + text.length > CONTEXT_BUDGET_CHARS) {
            dropped++;
            return;
        }
        const id = `M${idByKey.size + 1}`;
        const key = entry.chunk.id || `${entry.chunk.section || ''}::${(entry.chunk.text || '').slice(0, 60)}`;
        idByKey.set(key, id);
        const section = cleanSection(entry.chunk.section) || `chunk ${entry.chunk.id}`;
        library += `\n[${id} | Sez. ${section}]\n${text}\n`;
        usedChars += text.length;
    });

    // 4. Per-question reference list (original numbering preserved).
    let refs = '';
    items.forEach(({ num, result }) => {
        const ids = (result?.matches || [])
            .map(match => {
                const chunk = match.chunk || {};
                const key = chunk.id || `${chunk.section || ''}::${(chunk.text || '').slice(0, 60)}`;
                return idByKey.get(key);
            })
            .filter(Boolean);

        if (ids.length > 0) {
            refs += `DOMANDA ${num} - CONTESTO (${result.searchMethod}): ${ids.join(', ')}\n`;
        } else {
            refs += `DOMANDA ${num} - NO CONTESTO\n`;
        }
    });

    const context = library
        ? `=== MATERIALE DAL CORSO ===${library}\n=== ESTRATTI RILEVANTI PER OGNI DOMANDA ===\n${refs}`
        : `\n${refs}`;

    // What the old one-chunk-per-question-inline format would have cost.
    const naiveChars = items.reduce((sum, { result }) =>
        sum + (result?.matches || []).reduce((s, m) => s + Math.min((m.chunk?.text || '').length, 1500), 0), 0);

    return {
        context,
        stats: {
            uniqueChunks: idByKey.size,
            totalRefs: items.reduce((s, { result }) => s + (result?.matches?.length || 0), 0),
            contextChars: context.length,
            naiveChars,
            droppedChunks: dropped
        }
    };
}

function buildRagContext(items) {
    return buildRagContextWithStats(items).context;
}

// Single source of truth for the analysis prompt. Accepts questions with
// EXPLICIT numbers (not necessarily sequential), so the same builder serves
// both the full quiz and a targeted retry of only the unresolved questions.
// numberedQuestions: [{ num, text, options }]
// opts.forceAnswer: when true, forbid "?"/"not found" and demand a best guess.
function buildAnalysisPrompt(contextText, numberedQuestions, opts = {}) {
    const { forceAnswer = false } = opts;
    const nums = numberedQuestions.map(q => q.num);
    const ex1 = nums[0] ?? 1;
    const ex2 = nums[1] ?? ex1 + 1;

    const questionsText = numberedQuestions.map(q =>
        `${q.num}. ${stripLeadingNum(q.text)}\nA) ${q.options?.A || ''}\nB) ${q.options?.B || ''}\nC) ${q.options?.C || ''}\nD) ${q.options?.D || ''}`
    ).join('\n\n');

    const notFoundRule = forceAnswer
        ? `- Anche se il contesto NON contiene la risposta, scegli SEMPRE l'opzione più probabile in base alle tue conoscenze. NON lasciare MAI una domanda senza la riga [CORRETTA].`
        : `- Se il contesto non contiene la risposta, scrivi [AI] e spiega brevemente — ma scegli COMUNQUE l'opzione più probabile e marcala con [CORRETTA].`;

    return `Analizza le domande del quiz usando il contesto fornito dal corso.

ISTRUZIONI CRITICHE:
- Per ogni risposta cerca il testo esatto dal contesto tra virgolette "..."
- Indica SEMPRE la sezione di provenienza nel formato [Sez. X.Y] (es. [Sez. 1.9]) — la sezione è nell'intestazione di ogni estratto. Non usare mai "Pag." o "non specificata".
${notFoundRule}
- Marca SEMPRE una e una sola risposta come esatta.

COME LEGGERE IL CONTESTO:
Gli estratti del corso sono elencati UNA SOLA VOLTA, ciascuno con un id [M1], [M2], ...
e la sua sezione. Sotto trovi, per ogni domanda, quali estratti sono rilevanti.
Usa SOLO gli estratti indicati per quella domanda; se ne cerchi altri, ignorali.

${contextText}

DOMANDE (${numberedQuestions.length} domande):
${questionsText}

DEVI restituire SOLO una lista di blocchi RISPOSTA, uno per ogni domanda.
NON aggiungere intestazioni come "ANALISI:" o "RISPOSTE:".

Per OGNI domanda usa ESATTAMENTE questa struttura:

**${ex1}. [testo completo della domanda]**

A) [testo opzione A]
B) [testo opzione B]
C) [testo opzione C] [CORRETTA]
D) [testo opzione D]

Spiegazione: [CITATO] "citazione esatta dal corso" [Sez. 1.9]. La risposta corretta è C perché [spiegazione breve].

---

**${ex2}. [testo completo della domanda]**

A) [testo opzione A] [CORRETTA]
B) [testo opzione B]
C) [testo opzione C]

Spiegazione: [AI] La risposta corretta è A perché [spiegazione breve].

---

REGOLE OBBLIGATORIE:
- Il NUMERO e la DOMANDA devono essere in grassetto (**N. ...**)
- Aggiungi LETTERALMENTE la stringa "[CORRETTA]" (incluse le parentesi quadre) alla fine SOLO della riga con la risposta esatta
- NON usare ✓, V, (V), ✔ o altri simboli al posto di [CORRETTA]
- Usa --- tra una domanda e l'altra
- Usa per OGNI domanda il SUO numero originale: ${nums.join(', ')}
- NON aggiungere altre intestazioni o testo all'inizio o alla fine`;
}

// Normalize text for citation matching: the model rarely reproduces a quote
// byte-for-byte (accents, curly quotes, collapsed line breaks), so compare on
// a flattened form.
function normalizeForMatch(text) {
    return (text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[’‘`´]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        // L'apostrofo si tiene dentro la parola, perche' in italiano e' parte
        // del testo: "dell'impresa" non va spezzato. A bordo parola invece e'
        // punteggiatura, ed e' esattamente li' che il controllo si rompeva: il
        // modello, citando un passo che contiene una parola virgolettata, la
        // rende con apici semplici ('billy', 'come'), il corpus non li ha, e
        // una citazione autentica risultava introvabile. Misurato su venti
        // domande: tre risposte su quattro marcate NON_VERIFICATA divergevano
        // dal corpus esattamente su quel carattere, ed erano tutte corrette.
        .replace(/(^|\s)'+/g, '$1')
        .replace(/'+(?=\s|$)/g, '')
        .trim();
}

// A quote must be substantial to be worth verifying: matching "sì" against the
// corpus would always succeed and prove nothing.
const MIN_QUOTE_CHARS = 25;

/**
 * Check that a quote the model attributed to the course actually appears in
 * the context we sent it. Quotes are often elided ("inizio [...] fine"), so
 * every fragment must be found.
 */
function isQuoteInContext(quote, normalizedContext) {
    const parts = quote
        .split(/\[\.\.\.\]|\.\.\.|…/)
        .map(p => normalizeForMatch(p))
        .filter(p => p.length >= MIN_QUOTE_CHARS);

    if (parts.length === 0) return null; // too short to judge
    return parts.every(p => normalizedContext.includes(p));
}

/**
 * Parse the analysis into per-question answers.
 *
 * When `contextText` is provided, every "[CITATO]" claim is checked against
 * the material that was actually sent to the model. Without this the FONTE
 * column is only the model's word about itself: an invented quotation reaches
 * the user labelled exactly like a real one.
 *
 * Sources: CITATO (quote found), NON_VERIFICATA (quote claimed, not found),
 * AI (no quote).
 */
function parseAnswers(finalResponse, contextText = null) {
    const lines = finalResponse.split('\n');
    const answers = {};
    let currentQuestion = null;
    const normalizedContext = contextText ? normalizeForMatch(contextText) : null;

    lines.forEach(line => {
        const questionMatch = line.match(/^\s*\**\s*(\d+)[.)]/);
        if (questionMatch && /^\s*\*\*/.test(line)) {
            currentQuestion = questionMatch[1];
            if (!answers[currentQuestion]) {
                answers[currentQuestion] = { letter: '?', source: 'AI', quotes: [] };
            }
            return;
        }

        if (!currentQuestion) return;
        const entry = answers[currentQuestion];

        // Correct-answer marker. Tolerant on purpose: the marker may be
        // followed by more text, the line may be bold, the separator may be
        // ")" or ".", and the option may be E. Each variant that slipped
        // through used to leave a "?" and trigger a whole extra Opus pass.
        const correctMatch = line.match(/^\s*\**\s*([A-E])[).]\s.*?(\[CORRETTA\]|\(V\)|[✓✔])/i);
        if (correctMatch) {
            entry.letter = correctMatch[1].toUpperCase();
        }

        // Collect quoted spans so they can be checked against the material.
        const quoted = line.match(/"([^"]{10,})"|«([^»]{10,})»/g);
        if (quoted) {
            quoted.forEach(q => entry.quotes.push(q.replace(/^["«]|["»]$/g, '')));
        }

        if (line.includes('[CITATO]') || line.match(/\[Pag\.?\s*\d+\]/i) || line.match(/\[Sez\.?[^\]]*\]/i)) {
            entry.source = 'CITATO';
        } else if (line.includes('[AI]')) {
            entry.source = 'AI';
        }

        // Legacy fallback: "Risposta: X"
        const respMatch = line.match(/Risposta:\s*([A-Ea-e])\b/i);
        if (respMatch && entry.letter === '?') {
            entry.letter = respMatch[1].toUpperCase();
        }

        // Prose fallback: "la risposta corretta è X" — note \s* before the
        // connector, so "Risposta corretta: B" (no space) is caught too.
        if (entry.letter === '?') {
            const phrase = line.match(/risposta\s+corretta\s*(?:è|e'|e|:)?\s*([A-E])\b/i);
            if (phrase) {
                entry.letter = phrase[1].toUpperCase();
            }
        }
    });

    // Verify the citations, when we know what the model was actually given.
    if (normalizedContext) {
        Object.values(answers).forEach(entry => {
            if (entry.source !== 'CITATO') return;
            const verdicts = entry.quotes
                .map(q => isQuoteInContext(q, normalizedContext))
                .filter(v => v !== null);
            // No quote long enough to check, or none of them found → the
            // "citato" claim is not backed by the material we supplied.
            if (verdicts.length === 0 || !verdicts.some(Boolean)) {
                entry.source = 'NON_VERIFICATA';
            }
        });
    }

    Object.values(answers).forEach(e => delete e.quotes);
    return { answers, analysisText: finalResponse };
}

function buildTableHtml(questions, answers, startNumber) {
    let html = '<table style="width: 100%; border-collapse: collapse; margin: 15px 0;">';
    html += '<thead><tr>';
    html += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">N°</th>';
    html += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">RISPOSTA</th>';
    html += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">FONTE</th>';
    html += '</tr></thead><tbody>';

    const sourceStyles = {
        CITATO: { indicator: '📚 CITATO', color: '#34c759' },
        VERIFICATO: { indicator: '🔍 VERIFICATO', color: '#007aff' },
        AI: { indicator: '⚠️ AI', color: '#ff9500' }
    };

    for (let i = 0; i < questions.length; i++) {
        const questionNum = startNumber + i;
        const answer = answers[questionNum] || { letter: '?', source: 'AI' };
        const style = sourceStyles[answer.source] || sourceStyles.AI;

        html += '<tr>';
        html += `<td style="padding: 10px; text-align: center; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${questionNum}</td>`;
        html += `<td style="padding: 10px; text-align: center; font-weight: bold; font-size: 18px; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${answer.letter}</td>`;
        html += `<td style="padding: 10px; text-align: center; color: ${style.color}; font-weight: 600; border: 1px solid rgba(128,128,128,0.3);">${style.indicator}</td>`;
        html += '</tr>';
    }

    html += '</tbody></table>';
    return html;
}

function buildLegendHtml() {
    return `<div style="margin: 10px 0; padding: 10px; background: rgba(128,128,128,0.1); border-radius: 8px; font-size: 12px;">
        <b>Legenda:</b>
        <span style="color: #34c759; margin-left: 10px;">📚 CITATO</span> = citazione diretta dal PDF
        <span style="color: #007aff; margin-left: 10px;">🔍 VERIFICATO</span> = trovato nel PDF, rielaborato
        <span style="color: #ff9500; margin-left: 10px;">⚠️ AI</span> = non trovato nel materiale
    </div>`;
}

function formatMarkdown(text) {
    let cleanText = text
        .replace(/RISPOSTE\s*\(usa SEMPRE[^:]*\):[\s\S]*?(?=\d+\.\s*\*\*|ANALISI|$)/gi, '')
        .replace(/ANALISI\s*\(usa SEMPRE[^:]*\):/gi, '');

    return cleanText
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n{2,}/g, '\n')
        .replace(/\n/g, '<br>')
        .replace(/^(<br>)+/, '')
        .trim();
}

function buildFinalHtml(questions, answers, analysisText, finalResponse, questionBlocks, responseText) {
    const startNumber = questions[0]?.number || 1;
    const tableHtml = buildTableHtml(questions, answers, startNumber);
    const legendHtml = buildLegendHtml();

    return tableHtml + legendHtml +
        '<div style="margin-top: 20px;">' +
        '<h3 style="font-size: 16px; margin-bottom: 15px;">Analisi:</h3>' +
        '<div style="line-height: 1.8;">' +
        formatMarkdown(analysisText || finalResponse) +
        '</div></div>' +
        '<details style="margin-top: 20px; padding: 10px; background: #f5f5f5; border-radius: 8px;">' +
        '<summary style="cursor: pointer; font-weight: bold;">🔍 Debug: Parsing Info</summary>' +
        '<div style="font-size: 12px; margin-top: 10px; padding: 10px; background: #e0e0e0; border-radius: 4px;">' +
        `<b>Blocchi trovati:</b> ${questionBlocks}<br>` +
        `<b>Domande parsate:</b> ${questions.length}<br>` +
        `<b>Domande:</b> ${questions.map(q => q.text.substring(0, 30) + '...').join(' | ')}` +
        '</div>' +
        '<pre style="white-space: pre-wrap; font-size: 11px; margin-top: 10px; max-height: 300px; overflow-y: auto;">' +
        responseText.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</pre></details>';
}

module.exports = {
    buildContextFromSearchResults,
    buildExtractionPrompt,
    buildAnalysisPrompt,
    buildRagContext,
    buildRagContextWithStats,
    stripLeadingNum,
    parseAnswers,
    buildFinalHtml
};
