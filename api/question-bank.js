const fs = require('fs');
const path = require('path');

let bankCache = null;

function loadQuestionBank(courseName) {
    if (bankCache) return bankCache;

    const bankPath = path.join(__dirname, '..', 'data', 'processed', courseName, 'question-bank.json');
    if (!fs.existsSync(bankPath)) return null;

    try {
        const raw = fs.readFileSync(bankPath, 'utf-8');
        bankCache = JSON.parse(raw);
        console.log(`[QuestionBank] Loaded ${bankCache.count} questions for ${courseName}`);
        return bankCache;
    } catch (err) {
        console.error('[QuestionBank] Error loading:', err.message);
        return null;
    }
}

/**
 * Normalize text for fuzzy matching: lowercase, strip accents,
 * remove punctuation, collapse whitespace.
 */
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
        .replace(/[''`]/g, "'")
        .replace(/[^\w\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compute similarity between two normalized strings using
 * longest common substring ratio + token overlap.
 */
function similarity(a, b) {
    if (a === b) return 1;

    // Token overlap (Jaccard)
    const tokA = new Set(a.split(' ').filter(t => t.length > 2));
    const tokB = new Set(b.split(' ').filter(t => t.length > 2));
    if (tokA.size === 0 || tokB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokA) {
        if (tokB.has(t)) intersection++;
    }
    const jaccard = intersection / (tokA.size + tokB.size - intersection);

    // Length similarity penalty
    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

    return jaccard * 0.7 + lenRatio * 0.3;
}

/**
 * Look up extracted questions in the question bank.
 * Returns an array of { questionIndex, bankMatch } for matched questions.
 * bankMatch contains { correct, explanation, chapter, question, options }.
 * Threshold: 0.65 similarity.
 */
function lookupQuestions(questions, courseName) {
    const bank = loadQuestionBank(courseName || 'organizzazione-e-lavoro');
    if (!bank) return [];

    const matches = [];

    questions.forEach((q, idx) => {
        const normQ = normalize(q.text);
        let bestScore = 0;
        let bestMatch = null;

        for (const bankQ of bank.questions) {
            const normBankQ = normalize(bankQ.question);
            const score = similarity(normQ, normBankQ);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = bankQ;
            }
        }

        if (bestScore >= 0.65 && bestMatch) {
            matches.push({
                questionIndex: idx,
                score: bestScore,
                bankMatch: bestMatch
            });
        }
    });

    return matches;
}

module.exports = { loadQuestionBank, lookupQuestions, normalize, similarity };
