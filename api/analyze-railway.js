const { loadEnhancedData, loadEmbeddings } = require('./data-loader');
const { hybridSearch } = require('./search');
const { extractQuestions, analyzeWithContext } = require('./claude-client');
const { parseQuestions } = require('./question-parser');
const {
    lookupQuestions,
    buildHaikuVerificationPrompt,
    parseHaikuResponse
} = require('./question-bank');
const {
    buildContextFromSearchResults,
    buildExtractionPrompt,
    buildAnalysisPrompt,
    parseAnswers,
    buildFinalHtml
} = require('./response-builder');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
        const data = await loadEnhancedData();
        return res.status(200).json({
            status: 'active',
            message: 'Quiz Assistant API - Railway Edition',
            apiKeyConfigured: !!apiKey,
            dataLoaded: !!data,
            chunksAvailable: data?.textChunks?.length || 0
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
        if (!apiKey) {
            return res.status(500).json({ error: 'ANTHROPIC_API_KEY_EVO non configurata' });
        }

        const startNumber = req.body.startNumber || 1;
        const extractionModelKey = 'sonnet';
        const analysisModelKey = req.body.precision === true ? 'opus' : 'sonnet';

        if (!req.body?.messages?.[0]?.content) {
            return res.status(400).json({ error: 'Formato richiesta non valido' });
        }

        const messageContent = req.body.messages[0].content;
        const imageContent = Array.isArray(messageContent)
            ? messageContent.find(c => c.type === 'image')
            : null;

        if (!imageContent?.source?.data) {
            return res.status(400).json({ error: 'Immagine non trovata o formato non valido' });
        }

        const data = await loadEnhancedData();
        if (!data?.textChunks?.length) {
            return res.status(500).json({ error: 'Impossibile caricare il corso' });
        }

        const embeddingsData = await loadEmbeddings();

        // Step 1: Extract questions from image (always Sonnet)
        const extraction = await extractQuestions(apiKey, imageContent, buildExtractionPrompt(), extractionModelKey);
        const responseText = extraction.text;

        // Step 2: Parse questions
        const questions = parseQuestions(responseText);
        if (questions.length === 0) {
            return res.status(400).json({
                error: 'Nessuna domanda estratta dall\'immagine. Assicurati che l\'immagine sia chiara e contenga domande.'
            });
        }

        // Step 2.5: Three-tier question bank lookup
        const { direct, needsHaiku, unmatched } = lookupQuestions(questions, 'organizzazione-e-lavoro');

        let totalCost = extraction.cost || 0;
        const resolvedAnswers = {};  // num → { letter, source, explanation }
        const analysisParts = [];

        // --- Tier 1: Direct matches (mechanical remap, zero cost) ---
        direct.forEach(({ questionIndex, score, bankMatch, remappedLetter }) => {
            const num = startNumber + questionIndex;
            resolvedAnswers[num] = { letter: remappedLetter, source: 'QuestionBank' };
            analysisParts.push(
                `DOMANDA ${num}: ${remappedLetter}) ✅ [Question Bank – ${Math.round(score * 100)}% match]\n` +
                `${bankMatch.explanation}\n`
            );
        });
        console.log(`[QuestionBank] Tier 1 (direct): ${direct.length} questions`);

        // --- Tier 2: Haiku verification (low cost, semantic matching) ---
        if (needsHaiku.length > 0) {
            console.log(`[QuestionBank] Tier 2 (Haiku): ${needsHaiku.length} questions`);
            try {
                const haikuPrompt = buildHaikuVerificationPrompt(needsHaiku, questions, startNumber);
                const haikuResult = await analyzeWithContext(apiKey, haikuPrompt, 'haiku');
                totalCost += (haikuResult.cost || 0);

                const haikuAnswers = parseHaikuResponse(haikuResult.text, needsHaiku, questions, startNumber);

                needsHaiku.forEach(({ questionIndex, score, bankMatch }) => {
                    const num = startNumber + questionIndex;
                    const haikuAnswer = haikuAnswers.get(num);

                    if (haikuAnswer) {
                        resolvedAnswers[num] = { letter: haikuAnswer.letter, source: 'QuestionBank+Haiku' };
                        analysisParts.push(
                            `DOMANDA ${num}: ${haikuAnswer.letter}) ✅ [Question Bank + Haiku – ${Math.round(score * 100)}% match]\n` +
                            `${haikuAnswer.explanation}\n`
                        );
                    } else {
                        // Haiku said NO_MATCH — demote to Tier 3
                        unmatched.push(questionIndex);
                    }
                });
            } catch (err) {
                console.error('[QuestionBank] Haiku verification failed, falling back to RAG:', err.message);
                // On Haiku failure, demote all to Tier 3
                needsHaiku.forEach(({ questionIndex }) => unmatched.push(questionIndex));
            }
        }

        // --- Tier 3: Full RAG pipeline (unmatched questions) ---
        console.log(`[QuestionBank] Tier 3 (RAG): ${unmatched.length} questions`);

        let usedModel = 'question-bank';

        if (unmatched.length > 0) {
            // Extract only unmatched questions for RAG — avoid processing bank-resolved ones
            const unmatchedQuestions = unmatched.map(idx => questions[idx]);
            const unmatchedNums = unmatched.map(idx => startNumber + idx);

            // Search context only for unmatched questions
            const searchResults = await hybridSearch(unmatchedQuestions, data.textChunks, embeddingsData);

            // Build context with original question numbers
            let ragContext = '';
            unmatchedQuestions.forEach((q, i) => {
                const num = unmatchedNums[i];
                const result = searchResults[i];
                if (result?.searchMethod === 'semantic') {}
                if (result?.matches?.length > 0) {
                    ragContext += `\nDOMANDA ${num} - CONTESTO (${result.searchMethod}):\n`;
                    result.matches.slice(0, 4).forEach(match => {
                        const section = match.chunk.section || `chunk ${match.chunk.id}`;
                        ragContext += `[Sez. ${section}] ${match.chunk.text.substring(0, 1500)}\n`;
                    });
                } else {
                    ragContext += `\nDOMANDA ${num} - NO CONTESTO\n`;
                }
            });

            // Build questions text with original numbers
            const questionsText = unmatchedQuestions.map((q, i) =>
                `${unmatchedNums[i]}. ${q.text}\nA) ${q.options?.A || ''}\nB) ${q.options?.B || ''}\nC) ${q.options?.C || ''}\nD) ${q.options?.D || ''}`
            ).join('\n\n');

            const exampleNum1 = unmatchedNums[0] || 1;
            const exampleNum2 = unmatchedNums[1] || exampleNum1 + 1;

            const ragPrompt = `Analizza le domande del quiz usando il contesto fornito dal corso.

ISTRUZIONI CRITICHE:
- Per ogni risposta cerca il testo esatto dal contesto tra virgolette "..."
- Indica SEMPRE la sezione di provenienza nel formato [Sez. X.Y] (es. [Sez. 1.9]) — la sezione è indicata all'inizio di ogni chunk di contesto. Non usare mai "Pag." o "non specificata".
- Se il contesto non contiene la risposta, scrivi [AI] e spiega brevemente
- Marca SEMPRE quale risposta è esatta con "✓"

CONTESTO DAL CORSO:
${ragContext}

DOMANDE (${unmatchedQuestions.length} domande):
${questionsText}

DEVI restituire SOLO una lista di blocchi RISPOSTA, uno per ogni domanda.
NON aggiungere intestazioni come "ANALISI:" o "RISPOSTE:".

Per OGNI domanda usa ESATTAMENTE questa struttura:

**${exampleNum1}. [testo completo della domanda]**

A) [testo opzione A]
B) [testo opzione B]
C) [testo opzione C] [CORRETTA]
D) [testo opzione D]

Spiegazione: [CITATO] "citazione esatta dal corso" [Sez. 1.9]. La risposta corretta è C perché [spiegazione breve].

---

**${exampleNum2}. [testo completo della domanda]**

A) [testo opzione A] [CORRETTA]
B) [testo opzione B]
C) [testo opzione C]

Spiegazione: [AI] Non trovato nel materiale. La risposta corretta è A basata su conoscenze generali.

---

REGOLE OBBLIGATORIE:
- Il NUMERO e la DOMANDA devono essere in grassetto (**N. ...**)
- Aggiungi LETTERALMENTE la stringa "[CORRETTA]" (incluse le parentesi quadre) alla fine SOLO della riga con la risposta esatta
- NON usare ✓, V, (V), ✔ o altri simboli al posto di [CORRETTA]
- Usa --- tra una domanda e l'altra
- NON aggiungere altre intestazioni o testo all'inizio o alla fine`;

            const analysisResult = await analyzeWithContext(apiKey, ragPrompt, analysisModelKey);
            usedModel = analysisResult.model;
            totalCost += (analysisResult.cost || 0);

            const { answers: aiAnswers, analysisText } = parseAnswers(analysisResult.text);

            unmatched.forEach(idx => {
                const num = startNumber + idx;
                if (!resolvedAnswers[num]) {
                    const answer = aiAnswers[num] || { letter: '?', source: 'AI' };
                    resolvedAnswers[num] = { letter: answer.letter, source: answer.source };
                }
            });

            if (analysisText) {
                analysisParts.push(analysisText);
            } else {
                analysisParts.push(analysisResult.text);
            }
        }

        // Build final response
        const finalAnswersArray = questions.map((q, i) => {
            const num = startNumber + i;
            const resolved = resolvedAnswers[num] || { letter: '?', source: 'unknown' };
            return { num, letter: resolved.letter, source: resolved.source };
        });

        const bankResolved = direct.length + needsHaiku.filter(h => resolvedAnswers[startNumber + h.questionIndex]?.source?.includes('Haiku')).length;

        res.status(200).json({
            answers: finalAnswersArray,
            analysis: analysisParts.join('\n---\n'),
            metadata: {
                model: unmatched.length > 0 ? usedModel : (needsHaiku.length > 0 ? 'haiku' : 'question-bank'),
                processingMethod: unmatched.length === 0
                    ? (needsHaiku.length > 0 ? 'question-bank+haiku' : 'question-bank')
                    : (embeddingsData ? 'semantic-search-railway' : 'keyword-search-railway'),
                searchStats: {
                    tier1_direct: direct.length,
                    tier2_haiku: bankResolved - direct.length,
                    tier3_rag: unmatched.length,
                    total: questions.length
                },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length,
                cost: totalCost
            }
        });

    } catch (error) {
        const statusMap = {
            no_credits: 402,
            auth: 401,
            rate_limit: 429
        };
        const status = statusMap[error.kind] || 500;
        res.status(status).json({
            error: error.message || 'Errore interno',
            kind: error.kind || 'unknown',
            timestamp: new Date().toISOString()
        });
    }
};
