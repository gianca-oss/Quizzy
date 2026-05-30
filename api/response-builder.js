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

// Build per-question RAG context preserving the ORIGINAL question numbers.
// items: [{ num, result }] where result is a hybridSearch result.
function buildRagContext(items) {
    let ctx = '';
    items.forEach(({ num, result }) => {
        if (result?.matches?.length > 0) {
            ctx += `\nDOMANDA ${num} - CONTESTO (${result.searchMethod}):\n`;
            result.matches.slice(0, 4).forEach(match => {
                const section = match.chunk.section || `chunk ${match.chunk.id}`;
                ctx += `[Sez. ${section}] ${match.chunk.text.substring(0, 1500)}\n`;
            });
        } else {
            ctx += `\nDOMANDA ${num} - NO CONTESTO\n`;
        }
    });
    return ctx;
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
- Indica SEMPRE la sezione di provenienza nel formato [Sez. X.Y] (es. [Sez. 1.9]) — la sezione è indicata all'inizio di ogni chunk di contesto. Non usare mai "Pag." o "non specificata".
${notFoundRule}
- Marca SEMPRE una e una sola risposta come esatta.

CONTESTO DAL CORSO:
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

function parseAnswers(finalResponse) {
    const lines = finalResponse.split('\n');
    const answers = {};
    let currentQuestion = null;

    lines.forEach(line => {
        const questionMatch = line.match(/^\s*\*\*(\d+)\./);
        if (questionMatch) {
            currentQuestion = questionMatch[1];
            if (!answers[currentQuestion]) {
                answers[currentQuestion] = { letter: '?', source: 'AI' };
            }
            return;
        }

        if (!currentQuestion) return;

        // Detect correct answer via marker on option line: [CORRETTA], ✓, ✔, (V), V
        const correctMatch = line.match(/^\s*([A-D])\)\s.*(\[CORRETTA\]|\(V\)|[✓✔])\s*$/i);
        if (correctMatch) {
            answers[currentQuestion].letter = correctMatch[1].toUpperCase();
        }

        // Detect source from explanation
        if (line.includes('[CITATO]') || line.match(/\[Pag\.?\s*\d+\]/i) || line.match(/\[Sez\.?\s*[\d.]+\]/i)) {
            answers[currentQuestion].source = 'CITATO';
        } else if (line.includes('[VERIFICATO]')) {
            answers[currentQuestion].source = 'VERIFICATO';
        } else if (line.includes('[AI]')) {
            answers[currentQuestion].source = 'AI';
        }

        // Legacy fallback: "Risposta: X"
        const respMatch = line.match(/Risposta:\s*([A-Da-d])/i);
        if (respMatch && answers[currentQuestion].letter === '?') {
            answers[currentQuestion].letter = respMatch[1].toUpperCase();
        }

        // Prose fallback: "la risposta corretta è X" (è / e' / :) when no
        // [CORRETTA] marker survived. Lets us recover a letter from the
        // explanation sentence instead of leaving a "?".
        if (answers[currentQuestion].letter === '?') {
            const phrase = line.match(/risposta\s+corretta\s+(?:è|e'|e|:)?\s*([A-D])\b/i);
            if (phrase) {
                answers[currentQuestion].letter = phrase[1].toUpperCase();
            }
        }
    });

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
    stripLeadingNum,
    parseAnswers,
    buildFinalHtml
};
