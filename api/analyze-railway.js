// api/analyze-railway.js - Quiz analyzer API for Railway (Express compatible)
// Con ricerca semantica OpenAI Embeddings

// Helper per gestire rate limits con retry automatico
async function callClaudeWithRetry(url, options, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);

            if (response.status === 429) {
                const waitTime = Math.min(Math.pow(2, i) * 2000, 15000);
                console.log(`Rate limit hit, waiting ${waitTime}ms before retry ${i + 1}/${maxRetries}`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            if (!response.ok) {
                const clonedResponse = response.clone();
                const errorBody = await clonedResponse.text();
                console.error(`API Error ${response.status}:`, errorBody);

                if (response.status === 401) {
                    throw new Error('API Key non valida o mancante');
                }

                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }

            return response;
        } catch (error) {
            console.error(`Tentativo ${i + 1} fallito:`, error.message);
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Cache per i dati
let enhancedDataCache = null;
let embeddingsCache = null;

// ============================================
// RICERCA SEMANTICA CON OPENAI EMBEDDINGS
// ============================================

/**
 * Calcola la similarità coseno tra due vettori
 */
function cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Ottiene embedding da OpenAI per una query
 */
async function getQueryEmbedding(text) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        console.log('⚠️ OPENAI_API_KEY non configurata, uso ricerca keyword');
        return null;
    }

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text,
                dimensions: 512
            })
        });

        if (!response.ok) {
            console.error('OpenAI Embeddings error:', response.status);
            return null;
        }

        const data = await response.json();
        return data.data[0].embedding;
    } catch (error) {
        console.error('Errore OpenAI Embeddings:', error.message);
        return null;
    }
}

/**
 * Carica embeddings pre-calcolati da GitHub
 */
async function loadEmbeddings() {
    if (embeddingsCache) return embeddingsCache;

    try {
        console.log('🧠 Caricamento embeddings semantici...');
        const GITHUB_BASE = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/strategia-internazionalizzazione/';

        const response = await fetch(GITHUB_BASE + 'embeddings.json');
        if (!response.ok) {
            console.log('⚠️ Embeddings non trovati, userò ricerca keyword');
            return null;
        }

        const data = await response.json();
        embeddingsCache = data;
        console.log(`✅ Caricati embeddings per ${data.chunks?.length || 0} chunks`);
        return data;
    } catch (error) {
        console.error('Errore caricamento embeddings:', error.message);
        return null;
    }
}

/**
 * Ricerca semantica: trova i chunk più simili alla domanda
 */
async function semanticSearch(questionText, options, embeddingsData, topK = 3) {
    // Costruisci query combinando domanda e opzioni
    const queryText = `${questionText} ${Object.values(options).join(' ')}`;

    // Ottieni embedding della query
    const queryEmbedding = await getQueryEmbedding(queryText);
    if (!queryEmbedding) return null;

    // Calcola similarità con tutti i chunks
    const similarities = embeddingsData.chunks.map(chunk => ({
        chunk: chunk,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    // Ordina per similarità decrescente
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Restituisci top K risultati
    return similarities.slice(0, topK).map(s => ({
        chunk: {
            id: s.chunk.id,
            text: s.chunk.text,
            page: s.chunk.page,
            pages: s.chunk.pages,
            keywords: s.chunk.keywords
        },
        score: Math.round(s.similarity * 100),
        similarity: s.similarity,
        page: s.chunk.page
    }));
}

/**
 * Ricerca ibrida: semantica + keyword per migliori risultati
 */
async function hybridSearch(questions, chunks, embeddingsData) {
    console.log(`🔍 Ricerca ibrida per ${questions.length} domande...`);

    const results = [];
    const useSemanticSearch = !!embeddingsData && !!process.env.OPENAI_API_KEY;

    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
        const question = questions[qIndex];
        let matches = [];

        // 1. Prova ricerca semantica
        if (useSemanticSearch) {
            console.log(`  Domanda ${qIndex + 1}: ricerca semantica...`);
            const semanticMatches = await semanticSearch(
                question.text,
                question.options,
                embeddingsData,
                3  // Top 3 risultati
            );

            if (semanticMatches && semanticMatches.length > 0) {
                console.log(`    ✓ Semantica: ${semanticMatches.length} match (sim max: ${semanticMatches[0].score}%)`);
                matches = semanticMatches;
            }
        }

        // 2. Fallback o integrazione con keyword search
        if (matches.length === 0) {
            console.log(`  Domanda ${qIndex + 1}: fallback ricerca keyword...`);
            const keywordMatches = keywordSearch(question, chunks);
            matches = keywordMatches;
        }

        results.push({
            question: question,
            matches: matches,
            searchMethod: matches.length > 0 && matches[0].similarity ? 'semantic' : 'keyword'
        });
    }

    return results;
}

/**
 * Ricerca keyword (fallback)
 */
function keywordSearch(question, chunks) {
    const keywords = [];

    const questionWords = question.text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !['della', 'delle', 'sono', 'quale', 'quali', 'come'].includes(word));

    keywords.push(...questionWords);

    Object.values(question.options).forEach(option => {
        const optionWords = option.toLowerCase()
            .replace(/[^\w\sàèéìòù]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 4);
        keywords.push(...optionWords.slice(0, 3));
    });

    const uniqueKeywords = [...new Set(keywords)].slice(0, 10);

    const matches = [];
    chunks.forEach(chunk => {
        const text = chunk.text.toLowerCase();
        let score = 0;

        uniqueKeywords.forEach(keyword => {
            if (text.includes(keyword)) {
                score += 10;
                if (text.includes(keyword + ' ') || text.includes(' ' + keyword)) {
                    score += 5;
                }
            }
        });

        const matchCount = uniqueKeywords.filter(k => text.includes(k)).length;

        if (matchCount >= 3 && score >= 30) {
            matches.push({
                chunk: chunk,
                score: score,
                matchCount: matchCount,
                page: chunk.page
            });
        }
    });

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 3);
}

async function loadEnhancedData() {
    if (enhancedDataCache) return enhancedDataCache;

    try {
        console.log('🚀 Caricamento dati del corso da GitHub...');

        const GITHUB_BASE = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/strategia-internazionalizzazione/';

        const metadataResponse = await fetch(GITHUB_BASE + 'metadata.json');

        if (!metadataResponse.ok) {
            console.log('Nessun metadata trovato, uso fallback...');
            return loadFallbackData();
        }

        const metadata = await metadataResponse.json();
        const textChunks = await loadTextChunks(GITHUB_BASE, metadata.stats?.totalFiles || 8);

        enhancedDataCache = {
            metadata,
            textChunks,
            version: metadata.version || '1.0',
            courseName: metadata.courseName || 'strategia-internazionalizzazione'
        };

        console.log(`✅ Corso "${metadata.courseName}" caricato: ${textChunks.length} chunks`);

        return enhancedDataCache;

    } catch (error) {
        console.error('⌛ Errore caricamento corso:', error);
        return loadFallbackData();
    }
}

async function loadFallbackData() {
    try {
        const FALLBACK_BASE = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/strategia-internazionalizzazione/';
        const chunks = [];

        for (let i = 0; i < 8; i++) {
            try {
                const response = await fetch(FALLBACK_BASE + `chunks_${i}.json`);
                if (response.ok) {
                    const data = await response.json();
                    chunks.push(...data);
                }
            } catch (e) {
                break;
            }
        }

        return {
            metadata: { version: 'fallback', courseName: 'strategia-internazionalizzazione' },
            textChunks: chunks,
            version: '1.0-fallback'
        };

    } catch (error) {
        console.error('Fallback fallito:', error);
        return null;
    }
}

async function loadTextChunks(baseUrl, totalFiles) {
    const chunks = [];

    console.log(`📚 Caricamento di ${totalFiles} file di chunks...`);

    for (let i = 0; i < totalFiles; i++) {
        try {
            const response = await fetch(baseUrl + `chunks_${i}.json`);
            if (response.ok) {
                const fileChunks = await response.json();
                chunks.push(...fileChunks);
                console.log(`  ✅ chunks_${i}.json caricato (${fileChunks.length} chunks)`);
            }
        } catch (error) {
            console.warn(`  ⚠️ Errore caricamento chunks_${i}.json:`, error.message);
            if (i === 0) break;
        }
    }

    return chunks;
}

// La vecchia searchForAnswers è stata sostituita da hybridSearch sopra

// Express-compatible handler (req, res instead of Vercel's handler)
module.exports = async function handler(req, res) {
    // CORS headers
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
        console.log('🚀 Avvio analisi quiz CON RICERCA NEL CORSO...');

        const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
        if (!apiKey) {
            console.error('⌛ API Key non configurata');
            return res.status(500).json({
                error: 'ANTHROPIC_API_KEY_EVO non configurata'
            });
        }

        // Numero da cui partire per la numerazione (default: 1)
        const startNumber = req.body.startNumber || 1;
        console.log(`📊 Numerazione domande parte da: ${startNumber}`);

        if (!req.body || !req.body.messages || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
            return res.status(400).json({
                error: 'Formato richiesta non valido: messages mancanti'
            });
        }

        const messageContent = req.body.messages[0].content;

        if (!messageContent || !Array.isArray(messageContent)) {
            return res.status(400).json({
                error: 'Formato richiesta non valido: content non valido'
            });
        }

        const imageContent = messageContent.find(c => c.type === 'image');

        if (!imageContent) {
            return res.status(400).json({
                error: 'Immagine non trovata nella richiesta'
            });
        }

        if (!imageContent.source || !imageContent.source.data) {
            return res.status(400).json({
                error: 'Formato immagine non valido'
            });
        }

        // STEP 1: Carica il corso e embeddings
        const data = await loadEnhancedData();
        if (!data || !data.textChunks || data.textChunks.length === 0) {
            console.error('⌛ Nessun dato del corso disponibile!');
            return res.status(500).json({
                error: 'Impossibile caricare il corso'
            });
        }

        // Carica embeddings per ricerca semantica (opzionale)
        const embeddingsData = await loadEmbeddings();

        // STEP 2: Estrai le domande dall'immagine con OPUS (Railway ha timeout lungo!)
        console.log('🔍 Estrazione domande dal quiz...');

        await new Promise(resolve => setTimeout(resolve, 1000));

        const extractPrompt = `Quante domande ci sono in questa immagine? Elencale TUTTE.

Formato:
DOMANDA_1
TESTO: [domanda]
A: [opzione]
B: [opzione]
C: [opzione]
---
(ripeti per ogni domanda fino all'ultima)`;

        let extractResponse;
        try {
            extractResponse = await callClaudeWithRetry('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4000,
                    temperature: 0,
                    messages: [{
                        role: 'user',
                        content: [imageContent, { type: 'text', text: extractPrompt }]
                    }]
                })
            });
        } catch (error) {
            console.error('Errore nella chiamata API di estrazione:', error);
            return res.status(500).json({
                error: `Errore chiamata API Claude: ${error.message}`
            });
        }

        if (!extractResponse.ok) {
            const errorText = await extractResponse.text();
            console.error('Risposta non OK dall\'API:', extractResponse.status, errorText);

            let errorMessage = `Errore API Claude (${extractResponse.status})`;
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error?.message || errorData.message || errorMessage;
            } catch (e) {
                errorMessage += `: ${errorText.substring(0, 200)}`;
            }

            return res.status(500).json({
                error: errorMessage
            });
        }

        let extractData;
        try {
            extractData = await extractResponse.json();
        } catch (error) {
            console.error('Errore nel parsing della risposta:', error);
            return res.status(500).json({
                error: 'Risposta API non valida'
            });
        }

        if (!extractData || !extractData.content || !extractData.content[0]) {
            console.error('Struttura risposta non valida:', extractData);
            return res.status(500).json({
                error: 'Risposta API incompleta'
            });
        }

        const responseText = extractData.content[0].text;
        console.log('📝 Testo estratto da Claude (prime 500 char):', responseText.substring(0, 500));

        // Parse domande
        let questions = [];
        const allBlocks = responseText.split(/---+/);
        console.log(`📦 Split ha prodotto ${allBlocks.length} blocchi totali`);

        const questionBlocks = allBlocks.filter(block => block.includes('TESTO:') || block.includes('DOMANDA'));
        console.log(`📦 Dopo filtro: ${questionBlocks.length} blocchi con TESTO/DOMANDA`);

        questionBlocks.forEach((block, index) => {
            const lines = block.trim().split('\n');
            const question = {
                number: index + 1,
                text: '',
                options: {}
            };

            lines.forEach(line => {
                line = line.trim();
                if (!line) return;

                if (line.toUpperCase().startsWith('TESTO:')) {
                    question.text = line.substring(6).trim();
                }
                else if (/^A\s*[:)]/i.test(line)) {
                    question.options.A = line.replace(/^A\s*[:)]\s*/i, '').trim();
                }
                else if (/^B\s*[:)]/i.test(line)) {
                    question.options.B = line.replace(/^B\s*[:)]\s*/i, '').trim();
                }
                else if (/^C\s*[:)]/i.test(line)) {
                    question.options.C = line.replace(/^C\s*[:)]\s*/i, '').trim();
                }
                else if (/^D\s*[:)]/i.test(line)) {
                    question.options.D = line.replace(/^D\s*[:)]\s*/i, '').trim();
                }
            });

            const optCount = Object.keys(question.options).length;
            console.log(`  Blocco ${index + 1}: testo="${question.text.substring(0, 40)}..." opzioni=${optCount}`);

            if (question.text && optCount >= 2) {
                questions.push(question);
            }
        });

        // Parsing alternativo se necessario
        if (questions.length === 0) {
            console.log('⚠️ Nessuna domanda trovata con il primo metodo, provo parsing alternativo...');

            const altPattern = /(?:^|\n)(?:DOMANDA[_ ]?\d+|(?:\d+)[.)\s])/gi;
            const altMatches = responseText.match(altPattern);

            if (altMatches) {
                console.log(`🔍 Trovati ${altMatches.length} potenziali inizi domanda con pattern alternativo`);

                const lines = responseText.split('\n');
                let currentQuestion = null;
                let questionNum = 0;

                lines.forEach(line => {
                    line = line.trim();

                    if (line.match(/^(?:DOMANDA[_ ]?\d+|(?:\d+)[.)\s])/i)) {
                        if (currentQuestion && currentQuestion.text) {
                            questions.push(currentQuestion);
                        }
                        questionNum++;
                        currentQuestion = {
                            number: questionNum,
                            text: '',
                            options: {}
                        };
                    } else if (currentQuestion) {
                        if (!currentQuestion.text && line.length > 10 && !line.match(/^[A-D][):.]/i)) {
                            currentQuestion.text = line;
                        } else if (line.match(/^[A-D][):.]/i)) {
                            const letter = line[0].toUpperCase();
                            currentQuestion.options[letter] = line.substring(2).trim();
                        }
                    }
                });

                if (currentQuestion && currentQuestion.text) {
                    questions.push(currentQuestion);
                }
            }
        }

        console.log(`✅ Estratte ${questions.length} domande`);

        if (questions.length === 0) {
            return res.status(400).json({
                error: 'Nessuna domanda estratta dall\'immagine. Assicurati che l\'immagine sia chiara e contenga domande.'
            });
        }

        // Limita a max 20 domande (Railway ha timeout più generoso)
        const MAX_QUESTIONS = 20;
        if (questions.length > MAX_QUESTIONS) {
            console.log(`⚠️ Troppe domande (${questions.length}), limito a ${MAX_QUESTIONS}`);
            questions = questions.slice(0, MAX_QUESTIONS);
        }

        // STEP 3: CERCA LE RISPOSTE NEL DOCUMENTO (ricerca ibrida: semantica + keyword)
        const searchResults = await hybridSearch(questions, data.textChunks, embeddingsData);

        const questionsWithContext = [];
        let semanticCount = 0;
        let keywordCount = 0;

        let contextPerQuestion = '';
        searchResults.forEach((result, index) => {
            const questionNum = startNumber + index;

            // Conta metodi di ricerca usati
            if (result.searchMethod === 'semantic') semanticCount++;
            else keywordCount++;

            if (result.matches.length > 0) {
                questionsWithContext.push(questionNum);
                contextPerQuestion += `\nDOMANDA ${questionNum} - CONTESTO (${result.searchMethod}):\n`;

                // Usa fino a 3 match per più contesto
                const contextsToUse = result.matches.slice(0, 2);
                contextsToUse.forEach((match, mIdx) => {
                    const scoreInfo = match.similarity
                        ? `sim: ${Math.round(match.similarity * 100)}%`
                        : `score: ${match.score}`;
                    contextPerQuestion += `[Pag ${match.page}, ${scoreInfo}] ${match.chunk.text.substring(0, 1200)}\n`;
                });
            } else {
                contextPerQuestion += `\nDOMANDA ${questionNum} - NO CONTESTO\n`;
            }
        });

        console.log(`📊 Ricerca completata: ${semanticCount} semantiche, ${keywordCount} keyword`);

        // STEP 4: Analisi finale con OPUS (Railway ha timeout lungo!)
        console.log('🎯 Analisi finale con contesto dal corso (usando Opus)...');

        const analysisPrompt = `Analizza le domande del quiz usando ESCLUSIVAMENTE il contesto fornito.

ISTRUZIONI CRITICHE:
- Per ogni risposta DEVI copiare il testo esatto dal contesto tra virgolette "..."
- Indica la pagina [Pag. X]
- Se il contesto non contiene la risposta, scrivi [AI] e spiega brevemente

CONTESTO DAL CORSO:
${contextPerQuestion}

DOMANDE (numerate da ${startNumber} a ${startNumber + questions.length - 1}):
${questions.map((q, idx) => `${startNumber + idx}. ${q.text}
A) ${q.options.A || ''} B) ${q.options.B || ''} C) ${q.options.C || ''} D) ${q.options.D || ''}`).join('\n')}

FORMATO RICHIESTO:

RISPOSTE (usa SEMPRE numeri da ${startNumber} a ${startNumber + questions.length - 1}, in ordine sequenziale):
${startNumber}. C [CITATO]
${startNumber + 1}. B [AI]
${startNumber + 2}. A [CITATO]
(IMPORTANTE: scrivi SEMPRE la lettera A/B/C/D, anche per [AI])

ANALISI (usa SEMPRE numeri da ${startNumber} a ${startNumber + questions.length - 1}, in ordine sequenziale):
**${startNumber}. Scrivi qui la domanda COMPLETA**
[CITATO] "citazione esatta" [Pag. X]
Risposta: C

**${startNumber + 1}. Scrivi qui la domanda COMPLETA**
[AI] Non nel contesto.
Risposta: B (basata sulle mie conoscenze)

(IMPORTANTE: numera le domande da ${startNumber} a ${startNumber + questions.length - 1} in ordine. Il NUMERO e la DOMANDA devono essere ENTRAMBI in grassetto, es: **${startNumber}. Domanda completa qui?**. Poi scrivi "Risposta: X" con una lettera A/B/C/D)`;

        let analysisResponse;
        try {
            // 🎯 Usa OPUS su Railway (5 min timeout!)
            analysisResponse = await callClaudeWithRetry('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-opus-4-20250514',  // OPUS su Railway!
                    max_tokens: 4000,
                    temperature: 0,
                    messages: [{
                        role: 'user',
                        content: [{ type: 'text', text: analysisPrompt }]
                    }]
                })
            });
        } catch (error) {
            console.error('Errore nella chiamata API di analisi:', error);
            return res.status(500).json({
                error: `Errore analisi finale: ${error.message}`
            });
        }

        if (!analysisResponse.ok) {
            const errorText = await analysisResponse.text();
            console.error('Errore analisi:', analysisResponse.status, errorText);
            return res.status(500).json({
                error: 'Errore nell\'analisi finale delle domande'
            });
        }

        const analysisData = await analysisResponse.json();
        const finalResponse = analysisData.content[0].text;

        console.log('RISPOSTA FINALE:', finalResponse.substring(0, 200) + '...');

        // Parse risposte e crea tabella
        let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin: 15px 0;">';
        tableHtml += '<thead><tr>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">N°</th>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">RISPOSTA</th>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">FONTE</th>';
        tableHtml += '</tr></thead><tbody>';

        const lines = finalResponse.split('\n');
        let analysisText = '';
        let foundAnalysis = false;
        const answers = {};
        let currentQuestion = null;

        lines.forEach(line => {
            if (line.includes('ANALISI:')) {
                foundAnalysis = true;
                analysisText = line.replace('ANALISI:', '').trim();
            } else if (foundAnalysis) {
                analysisText += '\n' + line;

                const questionMatch = line.match(/^\*\*(\d+)\./);
                if (questionMatch) {
                    currentQuestion = questionMatch[1];
                }

                if (currentQuestion && !answers[currentQuestion]) {
                    if (line.includes('[CITATO]') || line.match(/\[Pag\.?\s*\d+\]/i)) {
                        answers[currentQuestion] = { letter: '?', source: 'CITATO' };
                    } else if (line.includes('[AI]')) {
                        answers[currentQuestion] = { letter: '?', source: 'AI' };
                    } else if (line.includes('[VERIFICATO]')) {
                        answers[currentQuestion] = { letter: '?', source: 'VERIFICATO' };
                    }
                }

                const respMatch = line.match(/Risposta:\s*([A-Da-d])/i);
                if (respMatch && currentQuestion) {
                    if (answers[currentQuestion]) {
                        answers[currentQuestion].letter = respMatch[1].toUpperCase();
                    } else {
                        answers[currentQuestion] = { letter: respMatch[1].toUpperCase(), source: 'AI' };
                    }
                }
            } else {
                const match = line.match(/^(\d+)[.):]\s*([a-dA-D])\s*\[?(CITATO|VERIFICATO|AI)?\]?/i);
                if (match) {
                    answers[match[1]] = {
                        letter: match[2].toUpperCase(),
                        source: match[3] ? match[3].toUpperCase() : 'AI'
                    };
                }
            }
        });

        for (let i = 0; i < questions.length; i++) {
            const questionNum = startNumber + i;
            const answer = answers[questionNum] || { letter: '?', source: 'AI' };
            const letter = answer.letter;
            const source = answer.source;

            let sourceIndicator, sourceColor;
            if (source === 'CITATO') {
                sourceIndicator = '📚 CITATO';
                sourceColor = '#34c759';
            } else if (source === 'VERIFICATO') {
                sourceIndicator = '🔍 VERIFICATO';
                sourceColor = '#007aff';
            } else {
                sourceIndicator = '⚠️ AI';
                sourceColor = '#ff9500';
            }

            tableHtml += '<tr>';
            tableHtml += `<td style="padding: 10px; text-align: center; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${questionNum}</td>`;
            tableHtml += `<td style="padding: 10px; text-align: center; font-weight: bold; font-size: 18px; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${letter}</td>`;
            tableHtml += `<td style="padding: 10px; text-align: center; color: ${sourceColor}; font-weight: 600; border: 1px solid rgba(128,128,128,0.3);">${sourceIndicator}</td>`;
            tableHtml += '</tr>';
        }

        tableHtml += '</tbody></table>';

        const legendHtml = `
        <div style="margin: 10px 0; padding: 10px; background: rgba(128,128,128,0.1); border-radius: 8px; font-size: 12px;">
            <b>Legenda:</b>
            <span style="color: #34c759; margin-left: 10px;">📚 CITATO</span> = citazione diretta dal PDF
            <span style="color: #007aff; margin-left: 10px;">🔍 VERIFICATO</span> = trovato nel PDF, rielaborato
            <span style="color: #ff9500; margin-left: 10px;">⚠️ AI</span> = non trovato nel materiale
        </div>`;

        // Converti markdown **testo** in HTML <strong> e normalizza spaziatura
        const formatMarkdown = (text) => {
            // Rimuovi la sezione RISPOSTE che non deve essere mostrata
            let cleanText = text
                .replace(/RISPOSTE\s*\(usa SEMPRE[^:]*\):[\s\S]*?(?=\d+\.\s*\*\*|ANALISI|$)/gi, '')
                .replace(/ANALISI\s*\(usa SEMPRE[^:]*\):/gi, '');

            return cleanText
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n{2,}/g, '\n')  // Riduci righe vuote multiple a singola
                .replace(/\n/g, '<br>')
                .replace(/^(<br>)+/, '')   // Rimuovi <br> iniziali
                .trim();
        };

        const formattedContent = tableHtml + legendHtml +
            '<div style="margin-top: 20px;">' +
            '<h3 style="font-size: 16px; margin-bottom: 15px;">Analisi:</h3>' +
            '<div style="line-height: 1.8;">' +
            formatMarkdown(analysisText || finalResponse) +
            '</div></div>' +
            '<details style="margin-top: 20px; padding: 10px; background: #f5f5f5; border-radius: 8px;">' +
            '<summary style="cursor: pointer; font-weight: bold;">🔍 Debug: Parsing Info</summary>' +
            '<div style="font-size: 12px; margin-top: 10px; padding: 10px; background: #e0e0e0; border-radius: 4px;">' +
            `<b>Blocchi trovati:</b> ${questionBlocks.length}<br>` +
            `<b>Domande parsate:</b> ${questions.length}<br>` +
            `<b>Domande:</b> ${questions.map(q => q.text.substring(0, 30) + '...').join(' | ')}` +
            '</div>' +
            '<pre style="white-space: pre-wrap; font-size: 11px; margin-top: 10px; max-height: 300px; overflow-y: auto;">' +
            responseText.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</pre></details>';

        res.status(200).json({
            content: [{
                type: 'text',
                text: formattedContent
            }],
            metadata: {
                model: 'claude-opus-4-20250514',
                processingMethod: embeddingsData ? 'semantic-search-railway' : 'keyword-search-railway',
                searchStats: {
                    semantic: semanticCount,
                    keyword: keywordCount
                },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length,
                rawExtraction: responseText.substring(0, 2000)
            }
        });

    } catch (error) {
        console.error('⌛ Errore generale:', error);
        res.status(500).json({
            error: error.message || 'Errore interno',
            details: error.stack ? error.stack.split('\n')[0] : undefined,
            timestamp: new Date().toISOString()
        });
    }
};
