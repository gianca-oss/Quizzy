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
        await new Promise(resolve => setTimeout(resolve, 1000));
        const responseText = await extractQuestions(apiKey, imageContent, buildExtractionPrompt());

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
        const finalResponse = await analyzeWithContext(apiKey, analysisPrompt);

        // Step 5: Build response
        const { answers, analysisText } = parseAnswers(finalResponse);
        const questionBlocks = responseText.split(/---+/).filter(b => b.includes('TESTO:') || b.includes('DOMANDA')).length;
        const formattedContent = buildFinalHtml(questions, answers, analysisText, finalResponse, questionBlocks, responseText);

        res.status(200).json({
            content: [{ type: 'text', text: formattedContent }],
            metadata: {
                model: 'claude-opus-4-7-20250715',
                processingMethod: embeddingsData ? 'semantic-search-railway' : 'keyword-search-railway',
                searchStats: { semantic: semanticCount, keyword: keywordCount },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length,
                rawExtraction: responseText.substring(0, 2000)
            }
        });

    } catch (error) {
        res.status(500).json({
            error: error.message || 'Errore interno',
            timestamp: new Date().toISOString()
        });
    }
};
