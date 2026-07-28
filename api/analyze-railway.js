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
    buildExtractionPrompt,
    buildAnalysisPrompt,
    buildRagContextWithStats,
    stripLeadingNum,
    parseAnswers
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

        // Step 2.5: Three-tier question bank lookup.
        // Must follow the course actually in use: with the course hardcoded,
        // a Marketing quiz was matched against the Organizzazione e Lavoro
        // bank (915 useless comparisons per request) and a future Marketing
        // bank would never have been consulted at all.
        const courseName = data.courseName || process.env.COURSE_NAME;
        const { direct, needsHaiku, unmatched } = lookupQuestions(questions, courseName);

        let totalCost = extraction.cost || 0;
        const resolvedAnswers = {};  // num → { letter, source, analysis }

        // Run one RAG pass over a set of question indices with a given model.
        // Shares the single prompt builder (response-builder) so the format
        // stays in lockstep with the parser. With forceAnswer=true the model
        // is told to never leave a question without a [CORRETTA] line — used
        // for the "?" recovery retry. Returns { answersByNum, blocksByNum }.
        const resolveWithRag = async (indices, modelKey, forceAnswer = false) => {
            const qs = indices.map(idx => questions[idx]);
            const nums = indices.map(idx => startNumber + idx);

            const searchResults = await hybridSearch(qs, data.textChunks, embeddingsData);
            const ragItems = qs.map((q, i) => ({ num: nums[i], result: searchResults[i] }));
            const { context: ragContext, stats } = buildRagContextWithStats(ragItems);
            console.log(
                `[RAG] ${qs.length} domande · ${stats.uniqueChunks} estratti unici su ${stats.totalRefs} riferimenti · ` +
                `${Math.round(stats.contextChars / 1000)}k char di contesto (formato precedente: ~${Math.round(stats.naiveChars / 1000)}k)` +
                (stats.droppedChunks ? ` · ${stats.droppedChunks} estratti oltre budget` : '')
            );

            const numberedQuestions = qs.map((q, i) => ({
                num: nums[i], text: q.text, options: q.options
            }));
            const ragPrompt = buildAnalysisPrompt(ragContext, numberedQuestions, { forceAnswer });

            const analysisResult = await analyzeWithContext(apiKey, ragPrompt, modelKey);
            totalCost += (analysisResult.cost || 0);

            const { answers: aiAnswers, analysisText } = parseAnswers(analysisResult.text);

            // Split the RAG response into per-question blocks so each can be
            // stored next to its answer and re-ordered by question number.
            const blocksByNum = {};
            (analysisText || analysisResult.text)
                .split(/\n\s*---\s*\n/)
                .forEach(block => {
                    const m = block.match(/\*\*\s*(\d+)\./);
                    if (m) blocksByNum[parseInt(m[1], 10)] = block.trim();
                });

            return { answersByNum: aiAnswers, blocksByNum, model: analysisResult.model };
        };

        // Render an analysis block in the same format the RAG/UI expects:
        // **N. domanda** + opzioni con [CORRETTA] sulla risposta giusta + spiegazione.
        const renderBankBlock = (num, q, correctLetter, explanation, tag) => {
            let block = `**${num}. ${stripLeadingNum(q.text)}**\n\n`;
            ['A', 'B', 'C', 'D'].forEach(L => {
                if (q.options?.[L]) {
                    block += `${L}) ${q.options[L]}${L === correctLetter ? ' [CORRETTA]' : ''}\n`;
                }
            });
            block += `\nSpiegazione: ${explanation} ${tag}`;
            return block;
        };

        // --- Tier 1: Direct matches (mechanical remap, zero cost) ---
        direct.forEach(({ questionIndex, score, bankMatch, remappedLetter }) => {
            const num = startNumber + questionIndex;
            resolvedAnswers[num] = {
                letter: remappedLetter,
                source: 'QuestionBank',
                analysis: renderBankBlock(
                    num, questions[questionIndex], remappedLetter,
                    bankMatch.explanation, `[Question Bank – ${Math.round(score * 100)}% match]`
                )
            };
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
                        resolvedAnswers[num] = {
                            letter: haikuAnswer.letter,
                            source: 'QuestionBank+Haiku',
                            analysis: renderBankBlock(
                                num, questions[questionIndex], haikuAnswer.letter,
                                haikuAnswer.explanation, `[Question Bank + Haiku – ${Math.round(score * 100)}% match]`
                            )
                        };
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
            // First RAG pass over all unmatched questions.
            const { answersByNum, blocksByNum, model } = await resolveWithRag(unmatched, analysisModelKey);
            usedModel = model;

            unmatched.forEach(idx => {
                const num = startNumber + idx;
                if (!resolvedAnswers[num]) {
                    const answer = answersByNum[num] || { letter: '?', source: 'AI' };
                    resolvedAnswers[num] = {
                        letter: answer.letter,
                        source: answer.source,
                        analysis: blocksByNum[num] || ''
                    };
                }
            });

            // --- Intervention D: "?" recovery ---
            // Any question still without a confident letter gets one retry with
            // an escalated model + forceAnswer prompt. Re-querying the SAME model
            // at temperature 0 is pointless (identical output), so escalate
            // sonnet→opus; if already opus, retry opus with forceAnswer only.
            const stillUnknown = unmatched.filter(idx => {
                const r = resolvedAnswers[startNumber + idx];
                return !r || r.letter === '?';
            });

            if (stillUnknown.length > 0) {
                // Escalate to the strongest model for the recovery pass. (At
                // temperature 0, re-querying the same model yields identical
                // output, so the retry only helps if it differs — escalate.)
                const retryModel = 'opus';
                console.log(`[Recovery] Retrying ${stillUnknown.length} unresolved question(s) with ${retryModel} + forceAnswer`);
                try {
                    const retry = await resolveWithRag(stillUnknown, retryModel, true);
                    stillUnknown.forEach(idx => {
                        const num = startNumber + idx;
                        const answer = retry.answersByNum[num];
                        if (answer && answer.letter !== '?') {
                            resolvedAnswers[num] = {
                                letter: answer.letter,
                                source: answer.source || 'AI',
                                analysis: retry.blocksByNum[num] || resolvedAnswers[num]?.analysis || ''
                            };
                        }
                    });
                    usedModel = retry.model || usedModel;
                } catch (err) {
                    console.error('[Recovery] Retry failed:', err.message);
                }
            }
        }

        // Build final response — table source and analysis both come from the
        // same per-question entry, assembled strictly in question-number order.
        const finalAnswersArray = questions.map((q, i) => {
            const num = startNumber + i;
            const resolved = resolvedAnswers[num] || { letter: '?', source: 'unknown' };
            return { num, letter: resolved.letter, source: resolved.source };
        });

        const analysisParts = finalAnswersArray
            .map(a => resolvedAnswers[a.num]?.analysis)
            .filter(Boolean);

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
