const { loadEnhancedData, loadEmbeddings } = require('./data-loader');
const { hybridSearch } = require('./search');
const { extractQuestions, analyzeWithContext } = require('./claude-client');
const { parseQuestions } = require('./question-parser');
const { lookupQuestions } = require('./question-bank');
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
        // Hybrid policy: Sonnet always handles image extraction (more reliable
        // at VERBATIM OCR), Opus is reserved for the reasoning step when
        // Modalità precisione is on.
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

        // Step 2.5: Check question bank for instant answers
        const bankMatches = lookupQuestions(questions, 'organizzazione-e-lavoro');
        const bankAnswers = {};
        const bankAnalysisParts = [];
        bankMatches.forEach(({ questionIndex, score, bankMatch }) => {
            const num = startNumber + questionIndex;
            bankAnswers[num] = { letter: bankMatch.correct, source: 'QuestionBank' };
            bankAnalysisParts.push(
                `DOMANDA ${num}: ${bankMatch.correct}) ✅ [Question Bank – ${Math.round(score * 100)}% match]\n` +
                `${bankMatch.explanation}\n`
            );
        });

        // Find questions NOT matched by the bank
        const unmatchedIndices = questions
            .map((_, i) => i)
            .filter(i => !bankAnswers[startNumber + i]);

        let finalAnswersArray;
        let finalAnalysis;
        let totalCost = extraction.cost || 0;
        let usedModel = 'question-bank';

        if (unmatchedIndices.length === 0) {
            // All questions answered from the bank — no API call needed
            finalAnswersArray = questions.map((q, i) => {
                const num = startNumber + i;
                return { num, letter: bankAnswers[num].letter, source: 'QuestionBank' };
            });
            finalAnalysis = bankAnalysisParts.join('\n');
        } else {
            // Step 3: Search for answers (only unmatched questions)
            const searchResults = await hybridSearch(questions, data.textChunks, embeddingsData);
            const { contextPerQuestion, semanticCount, keywordCount } = buildContextFromSearchResults(searchResults, startNumber);

            // Step 4: Final analysis (Sonnet by default, Opus if precision is on)
            const analysisPrompt = buildAnalysisPrompt(contextPerQuestion, questions, startNumber);
            const analysisResult = await analyzeWithContext(apiKey, analysisPrompt, analysisModelKey);
            const finalResponse = analysisResult.text;
            usedModel = analysisResult.model;
            totalCost += (analysisResult.cost || 0);

            // Step 5: Build response — merge bank + AI answers
            const { answers: aiAnswers, analysisText } = parseAnswers(finalResponse);

            finalAnswersArray = questions.map((q, i) => {
                const num = startNumber + i;
                if (bankAnswers[num]) {
                    return { num, letter: bankAnswers[num].letter, source: 'QuestionBank' };
                }
                const answer = aiAnswers[num] || { letter: '?', source: 'AI' };
                return { num, letter: answer.letter, source: answer.source };
            });

            // Merge analysis text: bank answers first, then AI analysis
            finalAnalysis = bankAnalysisParts.length > 0
                ? bankAnalysisParts.join('\n') + '\n---\n' + (analysisText || finalResponse)
                : (analysisText || finalResponse);
        }

        res.status(200).json({
            answers: finalAnswersArray,
            analysis: finalAnalysis,
            metadata: {
                model: usedModel,
                processingMethod: unmatchedIndices.length === 0 ? 'question-bank' : (embeddingsData ? 'semantic-search-railway' : 'keyword-search-railway'),
                searchStats: { bankMatched: bankMatches.length, bankTotal: questions.length },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length,
                cost: totalCost
            }
        });

    } catch (error) {
        // Map permanent Anthropic errors to proper HTTP codes so the frontend
        // can show a tailored message AND skip auto-retry.
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
