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
                const scoreInfo = match.similarity
                    ? `sim: ${Math.round(match.similarity * 100)}%`
                    : `score: ${match.score}`;
                contextPerQuestion += `[${scoreInfo}] ${match.chunk.text.substring(0, 1500)}\n`;
            });
        } else {
            contextPerQuestion += `\nDOMANDA ${questionNum} - NO CONTESTO\n`;
        }
    });

    return { contextPerQuestion, semanticCount, keywordCount };
}

function buildExtractionPrompt() {
    return `Estrai TUTTE le domande del quiz da questa immagine.

Rispondi ESCLUSIVAMENTE con un JSON valido, senza altro testo prima o dopo.

Formato richiesto:
{
  "questions": [
    {
      "text": "testo completo della domanda",
      "options": {
        "A": "testo opzione A",
        "B": "testo opzione B",
        "C": "testo opzione C"
      }
    }
  ]
}

REGOLE:
- Includi TUTTE le domande visibili nell'immagine
- Trascrivi il testo ESATTAMENTE come appare
- Se un'opzione ha la lettera D, includila
- Non aggiungere spiegazioni, solo il JSON`;
}

function buildAnalysisPrompt(contextPerQuestion, questions, startNumber) {
    const endNumber = startNumber + questions.length - 1;
    const questionsText = questions.map((q, idx) =>
        `${startNumber + idx}. ${q.text}\nA) ${q.options.A || ''}\nB) ${q.options.B || ''}\nC) ${q.options.C || ''}\nD) ${q.options.D || ''}`
    ).join('\n\n');

    return `Analizza le domande del quiz usando il contesto fornito dal corso.

ISTRUZIONI CRITICHE:
- Per ogni risposta cerca il testo esatto dal contesto tra virgolette "..."
- Indica la pagina [Pag. X] quando disponibile
- Se il contesto non contiene la risposta, scrivi [AI] e spiega brevemente
- Marca SEMPRE quale risposta è esatta con "✓"

CONTESTO DAL CORSO:
${contextPerQuestion}

DOMANDE (numerate da ${startNumber} a ${endNumber}):
${questionsText}

DEVI restituire SOLO una lista di blocchi RISPOSTA, uno per ogni domanda.
NON aggiungere intestazioni come "ANALISI:" o "RISPOSTE:".

Per OGNI domanda da ${startNumber} a ${endNumber} usa ESATTAMENTE questa struttura:

**${startNumber}. [testo completo della domanda]**

A) [testo opzione A]
B) [testo opzione B]
C) [testo opzione C] [CORRETTA]
D) [testo opzione D]

Spiegazione: [CITATO] "citazione esatta dal corso" [Pag. X]. La risposta corretta è C perché [spiegazione breve].

---

**${startNumber + 1}. [testo completo della domanda]**

A) [testo opzione A] [CORRETTA]
B) [testo opzione B]
C) [testo opzione C]

Spiegazione: [AI] Non trovato nel materiale. La risposta corretta è A basata su conoscenze generali.

---

REGOLE:
- Il NUMERO e la DOMANDA devono essere in grassetto (**N. ...**)
- Aggiungi [CORRETTA] alla fine SOLO della riga con la risposta esatta
- Usa --- tra una domanda e l'altra
- Numera le domande da ${startNumber} a ${endNumber} in ordine
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

        // Detect correct answer via [CORRETTA] marker on option line
        const correctMatch = line.match(/^\s*([A-D])\)\s.*\[CORRETTA\]/i);
        if (correctMatch) {
            answers[currentQuestion].letter = correctMatch[1].toUpperCase();
        }

        // Detect source from explanation
        if (line.includes('[CITATO]') || line.match(/\[Pag\.?\s*\d+\]/i)) {
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
    parseAnswers,
    buildFinalHtml
};
