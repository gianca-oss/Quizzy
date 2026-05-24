const { loadEnhancedData, loadEmbeddings } = require('./data-loader');
const { hybridSearch } = require('./search');
const { extractQuestions, analyzeWithContext } = require('./claude-client');
const { parseQuestions } = require('./question-parser');
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
        const modelKey = req.body.precision === true ? 'opus' : 'sonnet';

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

        // Step 1: Extract questions from image
        const responseText = await extractQuestions(apiKey, imageContent, buildExtractionPrompt(), modelKey);

        // Step 2: Parse questions
        const questions = parseQuestions(responseText);
        if (questions.length === 0) {
            return res.status(400).json({
                error: 'Nessuna domanda estratta dall\'immagine. Assicurati che l\'immagine sia chiara e contenga domande.'
            });
        }

        // Step 3: Search for answers
        const searchResults = await hybridSearch(questions, data.textChunks, embeddingsData);
        const { contextPerQuestion, semanticCount, keywordCount } = buildContextFromSearchResults(searchResults, startNumber);

        // Step 4: Final analysis
        const analysisPrompt = buildAnalysisPrompt(contextPerQuestion, questions, startNumber);
        const { text: finalResponse, model: usedModel } = await analyzeWithContext(apiKey, analysisPrompt, modelKey);

        // Step 5: Build response
        const { answers, analysisText } = parseAnswers(finalResponse);

        const answersArray = questions.map((q, i) => {
            const num = startNumber + i;
            const answer = answers[num] || { letter: '?', source: 'AI' };
            return { num, letter: answer.letter, source: answer.source };
        });

        res.status(200).json({
            answers: answersArray,
            analysis: analysisText || finalResponse,
            metadata: {
                model: usedModel,
                processingMethod: embeddingsData ? 'semantic-search-railway' : 'keyword-search-railway',
                searchStats: { semantic: semanticCount, keyword: keywordCount },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length
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
