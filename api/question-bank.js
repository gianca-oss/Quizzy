const fs = require('fs');
const path = require('path');

// Cache keyed by course: a single shared slot would pin whichever course
// happened to load first and serve it to every other course.
const bankCache = new Map();

function loadQuestionBank(courseName) {
    if (!courseName) return null;
    if (bankCache.has(courseName)) return bankCache.get(courseName);

    const bankPath = path.join(__dirname, '..', 'data', 'processed', courseName, 'question-bank.json');
    if (!fs.existsSync(bankPath)) {
        console.log(`[QuestionBank] Nessun bank per "${courseName}" — si procede con la sola pipeline RAG`);
        bankCache.set(courseName, null);
        return null;
    }

    try {
        const raw = fs.readFileSync(bankPath, 'utf-8');
        const bank = JSON.parse(raw);
        bankCache.set(courseName, bank);
        console.log(`[QuestionBank] Loaded ${bank.count} questions for ${courseName}`);
        return bank;
    } catch (err) {
        console.error('[QuestionBank] Error loading:', err.message);
        bankCache.set(courseName, null);
        return null;
    }
}

/**
 * Normalize text for fuzzy matching: lowercase, strip accents,
 * remove punctuation, collapse whitespace.
 *
 * Apostrophes are stripped entirely so that the bank's apostrophe-style
 * accents ("puo'", "perche'", "responsabilita'") collapse to the same
 * token as the OCR's real accents ("può", "perché", "responsabilità"),
 * which become "puo"/"perche"/"responsabilita" after accent removal.
 */
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[''`´]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compute similarity between two normalized strings using
 * token overlap (Jaccard) + length ratio.
 */
function similarity(a, b) {
    if (a === b) return 1;

    const tokA = new Set(a.split(' ').filter(t => t.length > 2));
    const tokB = new Set(b.split(' ').filter(t => t.length > 2));
    if (tokA.size === 0 || tokB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokA) {
        if (tokB.has(t)) intersection++;
    }
    const jaccard = intersection / (tokA.size + tokB.size - intersection);
    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

    return jaccard * 0.7 + lenRatio * 0.3;
}

// Quanto il primo candidato deve staccare il secondo perche' il remap sia
// considerato univoco.
const MIN_REMAP_MARGIN = 0.05;

/**
 * Try to mechanically remap the correct answer letter from the bank
 * to the photo's option ordering, by fuzzy-matching option texts.
 * Returns the remapped letter or null if no confident match.
 *
 * Un remap sbagliato qui e' il caso peggiore del sistema: la risposta esce a
 * Tier 1, senza modello e senza verifica, con l'etichetta "Question Bank" che
 * la fa sembrare la piu' affidabile di tutte. Quindi in caso di ambiguita' si
 * restituisce null e la domanda scende a Tier 2, dove Haiku rimappa leggendo.
 */
function mechanicalRemap(bankMatch, photoOptions) {
    const correctText = normalize(bankMatch.options[bankMatch.correct] || '');
    if (!correctText) return null;

    const entries = Object.entries(photoOptions)
        .map(([letter, text]) => ({ letter, norm: normalize(text) }));

    // Coincidenza esatta dopo normalizzazione: non c'e' nulla da stimare.
    // Copre il caso normale, in cui l'OCR restituisce la stessa opzione a meno
    // di accenti e punteggiatura.
    const exact = entries.filter(e => e.norm === correctText);
    if (exact.length === 1) return exact[0].letter;
    if (exact.length > 1) return null;

    const scored = entries
        .map(e => ({ letter: e.letter, score: similarity(correctText, e.norm) }))
        .sort((a, b) => b.score - a.score);

    const [best, runnerUp] = scored;
    if (!best || best.score < 0.85) return null;

    // Distrattori che differiscono solo per un numero ("Stati Uniti 13,5%,
    // Italia 9%" contro "... Italia 7%") o per l'ordine delle stesse parole
    // ottengono punteggi identici: similarity() scarta i token di uno o due
    // caratteri e la differenza non la vede proprio. Senza margine vinceva
    // semplicemente la prima opzione incontrata - misurato sul bank di
    // marketing: 14 lettere sbagliate su 386, dodici delle quali "A".
    if (runnerUp && best.score - runnerUp.score < MIN_REMAP_MARGIN) return null;

    return best.letter;
}

/**
 * Three-tier lookup:
 *
 * Tier 1 (score >= 0.90): Direct match — remap letter mechanically.
 *   If remap succeeds → instant answer, zero API cost.
 *   If remap fails (options too different) → demote to Tier 2.
 *
 * Tier 2 (score >= 0.65, or Tier 1 remap failure): Haiku verification.
 *   Send question + bank candidate to Haiku for semantic confirmation
 *   and letter remapping.
 *
 * Tier 3 (score < 0.65): No match — full RAG pipeline.
 *
 * Returns { direct: [...], needsHaiku: [...], unmatched: [...] }
 */
function lookupQuestions(questions, courseName) {
    const bank = loadQuestionBank(courseName);
    if (!bank) return { direct: [], needsHaiku: [], unmatched: questions.map((_, i) => i) };

    const direct = [];
    const needsHaiku = [];
    const unmatched = [];

    questions.forEach((q, idx) => {
        const normQ = normalize(q.text);
        let bestScore = 0;
        let bestMatch = null;

        for (const bankQ of bank.questions) {
            // Prefer the build-time precomputed `normalized` field (scripts/
            // normalize-bank.js); fall back to normalizing on the fly so the
            // code still works against a not-yet-normalized bank.
            const bankNorm = bankQ.normalized || normalize(bankQ.question);
            const score = similarity(normQ, bankNorm);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = bankQ;
            }
        }

        if (bestScore >= 0.90 && bestMatch) {
            // Tier 1: try mechanical remap
            const remapped = mechanicalRemap(bestMatch, q.options || {});
            if (remapped) {
                direct.push({ questionIndex: idx, score: bestScore, bankMatch: bestMatch, remappedLetter: remapped });
            } else {
                // Options too different — need Haiku to remap
                needsHaiku.push({ questionIndex: idx, score: bestScore, bankMatch: bestMatch });
            }
        } else if (bestScore >= 0.65 && bestMatch) {
            // Tier 2: needs Haiku semantic verification
            needsHaiku.push({ questionIndex: idx, score: bestScore, bankMatch: bestMatch });
        } else {
            // Tier 3: no match
            unmatched.push(idx);
        }
    });

    return { direct, needsHaiku, unmatched };
}

/**
 * Build a prompt for Haiku to verify bank matches and remap letters.
 * Handles multiple questions in a single call for efficiency.
 */
function buildHaikuVerificationPrompt(haikuCandidates, questions, startNumber) {
    let prompt = `Sei un assistente per quiz universitari. Per ogni domanda sotto, ti fornisco:
- La DOMANDA DALLA FOTO (con le sue opzioni A/B/C/D)
- Una DOMANDA CANDIDATA dal nostro database con la RISPOSTA CORRETTA

Il tuo compito:
1. Verifica se le due domande chiedono la stessa cosa (anche se formulate diversamente)
2. Se sì, trova quale lettera nelle opzioni della FOTO corrisponde alla risposta corretta del database
3. Se no, rispondi "NO_MATCH"

Rispondi SOLO con JSON valido, niente altro:
{"results": [{"num": N, "match": true/false, "letter": "A/B/C/D o null"}]}

`;

    haikuCandidates.forEach(({ questionIndex, bankMatch }) => {
        const q = questions[questionIndex];
        const num = startNumber + questionIndex;
        const correctText = bankMatch.options[bankMatch.correct];

        prompt += `---
DOMANDA ${num} DALLA FOTO:
${q.text}
`;
        if (q.options) {
            Object.entries(q.options).forEach(([letter, text]) => {
                prompt += `${letter}) ${text}\n`;
            });
        }

        prompt += `
CANDIDATA DAL DATABASE:
"${bankMatch.question}"
RISPOSTA CORRETTA: ${bankMatch.correct}) ${correctText}
SPIEGAZIONE: ${bankMatch.explanation}

`;
    });

    return prompt;
}

/**
 * Parse Haiku's verification response.
 * Returns Map<questionNum, { letter, explanation }>
 */
function parseHaikuResponse(responseText, haikuCandidates, questions, startNumber) {
    const results = new Map();

    try {
        const cleaned = responseText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
        const jsonMatch = cleaned.match(/\{[\s\S]*"results"[\s\S]*\}/);
        if (!jsonMatch) return results;

        const data = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(data.results)) return results;

        data.results.forEach(r => {
            if (r.match && r.letter && r.letter !== 'null') {
                // Find the corresponding bank match for the explanation
                const candidate = haikuCandidates.find(c => startNumber + c.questionIndex === r.num);
                if (candidate) {
                    results.set(r.num, {
                        letter: r.letter,
                        explanation: candidate.bankMatch.explanation
                    });
                }
            }
        });
    } catch (err) {
        console.error('[QuestionBank] Haiku parse error:', err.message);
    }

    return results;
}

module.exports = {
    loadQuestionBank,
    lookupQuestions,
    mechanicalRemap,
    buildHaikuVerificationPrompt,
    parseHaikuResponse,
    normalize,
    similarity
};
