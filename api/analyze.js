// api/analyze.js - Quiz analyzer API with PDF context search

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

            // Clone response prima di leggere il body per logging
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

/**
 * Carica i dati del corso da GitHub
 */
async function loadEnhancedData() {
    if (enhancedDataCache) return enhancedDataCache;
    
    try {
        console.log('🚀 Caricamento dati del corso da GitHub...');
        
        const GITHUB_BASE = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed-v3/';
        
        let metadataResponse = await fetch(GITHUB_BASE + 'metadata.json');
        let baseUrl = GITHUB_BASE;
        let version = '3.0';
        
        if (!metadataResponse.ok) {
            baseUrl = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed-v2/';
            metadataResponse = await fetch(baseUrl + 'metadata.json');
            version = '2.0';
        }
        
        if (!metadataResponse.ok) {
            baseUrl = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/';
            metadataResponse = await fetch(baseUrl + 'metadata.json');
            version = '1.0';
        }
        
        if (!metadataResponse.ok) {
            console.log('Nessun metadata trovato, uso fallback...');
            return loadFallbackData();
        }
        
        const metadata = await metadataResponse.json();
        
        // Carica PIÙ chunks per avere più contenuto
        const textChunks = await loadTextChunks(baseUrl, metadata.totalChunks || 500);
        
        enhancedDataCache = {
            metadata,
            textChunks,
            version: version
        };
        
        console.log(`✅ Corso v${version} caricato: ${textChunks.length} chunks`);
        
        return enhancedDataCache;
        
    } catch (error) {
        console.error('⌛ Errore caricamento corso:', error);
        return loadFallbackData();
    }
}

async function loadFallbackData() {
    try {
        const FALLBACK_BASE = 'https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/';
        const chunks = [];
        
        // Carica più file in fallback
        for (let i = 0; i <= 3; i++) {
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
            metadata: { version: 'fallback' },
            textChunks: chunks,
            version: '1.0-fallback'
        };
        
    } catch (error) {
        console.error('Fallback fallito:', error);
        return null;
    }
}

async function loadTextChunks(baseUrl, totalChunks) {
    const chunks = [];
    const chunksPerFile = 100;
    const numFiles = Math.ceil(totalChunks / chunksPerFile);
    
    console.log(`📚 Caricamento di ${Math.min(numFiles, 5)} file di chunks...`);
    
    // Carica fino a 5 file (500 chunks)
    for (let i = 0; i < Math.min(numFiles, 5); i++) {
        try {
            const response = await fetch(baseUrl + `chunks_${i}.json`);
            if (response.ok) {
                const fileChunks = await response.json();
                chunks.push(...fileChunks);
                console.log(`  ✅ chunks_${i}.json caricato`);
            }
        } catch (error) {
            if (i === 0) break;
        }
    }
    
    return chunks;
}

/**
 * RICERCA VERA nel documento per trovare risposte
 */
function searchForAnswers(questions, chunks) {
    console.log(`🔍 Ricerca risposte per ${questions.length} domande...`);
    
    const results = [];
    
    questions.forEach((question, qIndex) => {
        // Estrai parole chiave dalla domanda e opzioni
        const keywords = [];
        
        // Parole dalla domanda
        const questionWords = question.text.toLowerCase()
            .replace(/[^\w\sàèéìòù]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 3 && !['della', 'delle', 'sono', 'quale', 'quali', 'come'].includes(word));
        
        keywords.push(...questionWords);
        
        // Parole dalle opzioni
        Object.values(question.options).forEach(option => {
            const optionWords = option.toLowerCase()
                .replace(/[^\w\sàèéìòù]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length > 4);
            keywords.push(...optionWords.slice(0, 3));
        });
        
        // Rimuovi duplicati
        const uniqueKeywords = [...new Set(keywords)].slice(0, 10);
        
        console.log(`  Domanda ${qIndex + 1}: cercando "${uniqueKeywords.join(', ')}"`);
        
        // Cerca nei chunks
        const matches = [];
        chunks.forEach(chunk => {
            const text = chunk.text.toLowerCase();
            let score = 0;
            
            uniqueKeywords.forEach(keyword => {
                if (text.includes(keyword)) {
                    score += 10;
                    // Bonus se la keyword appare vicino a parole chiave del contesto
                    if (text.includes(keyword + ' ') || text.includes(' ' + keyword)) {
                        score += 5;
                    }
                }
            });
            
            // Conta quante keyword specifiche matchano
            const matchCount = uniqueKeywords.filter(k => text.includes(k)).length;

            // SOGLIA ESTREMA: richiedi almeno 7 keyword E score >= 150
            // Praticamente impossibile con keyword generiche
            // Solo match REALI verranno marcati come "dal PDF"
            if (matchCount >= 7 && score >= 150) {
                matches.push({
                    chunk: chunk,
                    score: score,
                    matchCount: matchCount,
                    page: chunk.page
                });
            }
        });
        
        // Prendi i migliori match per questa domanda
        matches.sort((a, b) => b.score - a.score);
        const topMatches = matches.slice(0, 3);
        
        if (topMatches.length > 0) {
            console.log(`    ✓ Trovati ${topMatches.length} match (score max: ${topMatches[0].score})`);
            results.push({
                question: question,
                matches: topMatches
            });
        } else {
            console.log(`    ✗ Nessun match trovato`);
            results.push({
                question: question,
                matches: []
            });
        }
    });
    
    return results;
}

export default async function handler(req, res) {
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
            message: 'Quiz Assistant API - Con Ricerca Documenti',
            apiKeyConfigured: !!apiKey,
            dataLoaded: !!data,
            chunksAvailable: data?.textChunks?.length || 0,
            apiKeyLength: apiKey ? apiKey.length : 0
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

        // Validazione del body della richiesta
        if (!req.body || !req.body.messages || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
            return res.status(400).json({ 
                error: 'Formato richiesta non valido: messages mancanti'
            });
        }

        const messageContent = req.body.messages[0].content;
        
        // Verifica che ci sia content
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

        // Verifica che l'immagine abbia il formato corretto
        if (!imageContent.source || !imageContent.source.data) {
            return res.status(400).json({ 
                error: 'Formato immagine non valido'
            });
        }

        // STEP 1: Carica il corso
        const data = await loadEnhancedData();
        if (!data || !data.textChunks || data.textChunks.length === 0) {
            console.error('⌛ Nessun dato del corso disponibile!');
            return res.status(500).json({ 
                error: 'Impossibile caricare il corso'
            });
        }

        // STEP 2: Estrai le domande dall'immagine
        console.log('🔍 Estrazione domande dal quiz...');
        console.log('API Key length:', apiKey.length);
        
        await new Promise(resolve => setTimeout(resolve, 1000)); // Delay per rate limit
        
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
            
            // Prova a parsare l'errore se è JSON
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

        // Parse domande - parsing semplificato e robusto
        const questions = [];
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

                // Estrai testo domanda
                if (line.toUpperCase().startsWith('TESTO:')) {
                    question.text = line.substring(6).trim();
                }
                // Estrai opzioni - pattern molto semplice: A: o A) all'inizio
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

            // Aggiungi se ha testo e almeno 2 opzioni
            if (question.text && optCount >= 2) {
                questions.push(question);
            }
        });
        
        // Se non troviamo domande con il primo metodo, proviamo un parsing alternativo
        if (questions.length === 0) {
            console.log('⚠️ Nessuna domanda trovata con il primo metodo, provo parsing alternativo...');
            
            // Prova a trovare pattern tipo "1." o "Domanda 1"
            const altPattern = /(?:^|\n)(?:DOMANDA[_ ]?\d+|(?:\d+)[.)\s])/gi;
            const altMatches = responseText.match(altPattern);
            
            if (altMatches) {
                console.log(`🔍 Trovati ${altMatches.length} potenziali inizi domanda con pattern alternativo`);
                
                // Parsing alternativo basato su numeri di domanda
                const lines = responseText.split('\n');
                let currentQuestion = null;
                let questionNum = 0;
                
                lines.forEach(line => {
                    line = line.trim();
                    
                    // Nuova domanda
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
                        // Cerca testo domanda o opzioni
                        if (!currentQuestion.text && line.length > 10 && !line.match(/^[A-D][):.]/i)) {
                            currentQuestion.text = line;
                        } else if (line.match(/^[A-D][):.]/i)) {
                            const letter = line[0].toUpperCase();
                            currentQuestion.options[letter] = line.substring(2).trim();
                        }
                    }
                });
                
                // Aggiungi l'ultima domanda
                if (currentQuestion && currentQuestion.text) {
                    questions.push(currentQuestion);
                }
            }
        }
        
        console.log(`✅ Estratte ${questions.length} domande`);
        
        // Log delle prime 2 domande per debug
        if (questions.length > 0) {
            console.log('📋 Prima domanda:', JSON.stringify(questions[0], null, 2));
            if (questions.length > 1) {
                console.log('📋 Seconda domanda:', JSON.stringify(questions[1], null, 2));
            }
        }

        if (questions.length === 0) {
            return res.status(400).json({ 
                error: 'Nessuna domanda estratta dall\'immagine. Assicurati che l\'immagine sia chiara e contenga domande.'
            });
        }

        // STEP 3: CERCA LE RISPOSTE NEL DOCUMENTO
        const searchResults = searchForAnswers(questions, data.textChunks);

        // Traccia quali domande hanno contesto dal PDF
        const questionsWithContext = [];

        // Costruisci contesto RILEVANTE per ogni domanda
        let contextPerQuestion = '';
        searchResults.forEach((result, index) => {
            if (result.matches.length > 0) {
                questionsWithContext.push(index + 1); // Domanda ha contesto
                contextPerQuestion += `\nDOMANDA ${index + 1} - CONTESTO TROVATO:\n`;
                result.matches.slice(0, 2).forEach(match => {
                    contextPerQuestion += `[Pag ${match.page}] ${match.chunk.text.substring(0, 300)}...\n`;
                });
            } else {
                contextPerQuestion += `\nDOMANDA ${index + 1} - NESSUN CONTESTO NEL CORSO\n`;
            }
        });

        // STEP 4: Chiedi a Claude di rispondere BASANDOSI SUL CONTESTO
        console.log('🎯 Analisi finale con contesto dal corso...');
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // Delay per rate limit
        
        const analysisPrompt = `CONTESTO DAL CORSO:
${contextPerQuestion}

DOMANDE DEL QUIZ:
${questions.map(q => `
${q.number}. ${q.text}
A) ${q.options.A || ''}
B) ${q.options.B || ''}
C) ${q.options.C || ''}
D) ${q.options.D || ''}
`).join('\n')}

RISPONDI IN QUESTO FORMATO ESATTO:

RISPOSTE:
1. C
2. B
3. A
(continua per tutte le ${questions.length} domande, una per riga)

ANALISI:
**1. testo domanda**
spiegazione

**2. testo domanda**
spiegazione
(continua per tutte)`;

        let analysisResponse;
        try {
            analysisResponse = await callClaudeWithRetry('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
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

        // Parse risposte e crea tabella (supporta dark mode)
        let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin: 15px 0;">';
        tableHtml += '<thead><tr>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">N°</th>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">RISPOSTA</th>';
        tableHtml += '<th style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); font-weight: 600; color: inherit;">FONTE</th>';
        tableHtml += '</tr></thead><tbody>';

        const lines = finalResponse.split('\n');
        let analysisText = '';
        let foundAnalysis = false;
        const answers = {}; // Mappa numero domanda -> risposta

        // Prima passa: cerca risposte nel formato "1. C" o "La risposta corretta è X"
        lines.forEach(line => {
            if (line.includes('ANALISI:')) {
                foundAnalysis = true;
                analysisText = line.replace('ANALISI:', '').trim();
            } else if (foundAnalysis) {
                analysisText += '\n' + line;
                // Cerca anche "La risposta corretta è X" nell'analisi
                const altMatch = line.match(/risposta\s+(?:corretta\s+)?(?:è|e)\s+([A-Da-d])/i);
                if (altMatch) {
                    // Trova il numero della domanda dal contesto (es. **1. o **2.)
                    const numMatch = analysisText.match(/\*\*(\d+)\.[^*]*$/);
                    if (numMatch && !answers[numMatch[1]]) {
                        answers[numMatch[1]] = altMatch[1].toUpperCase();
                    }
                }
            } else {
                // Parse risposte - formato "1. C"
                const match = line.match(/^(\d+)[.):]\s*([a-dA-D])\b/);
                if (match) {
                    answers[match[1]] = match[2].toUpperCase();
                }
            }
        });

        // Genera tabella con le risposte trovate
        for (let i = 1; i <= questions.length; i++) {
            const letter = answers[i] || '?';
            const hasContext = questionsWithContext.includes(i);
            const sourceIndicator = hasContext ? '📚 PDF' : '⚠️ AI';
            const sourceColor = hasContext ? '#34c759' : '#ff9500';

            tableHtml += '<tr>';
            tableHtml += `<td style="padding: 10px; text-align: center; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${i}</td>`;
            tableHtml += `<td style="padding: 10px; text-align: center; font-weight: bold; font-size: 18px; border: 1px solid rgba(128,128,128,0.3); color: inherit;">${letter}</td>`;
            tableHtml += `<td style="padding: 10px; text-align: center; color: ${sourceColor}; font-weight: 600; border: 1px solid rgba(128,128,128,0.3);">${sourceIndicator}</td>`;
            tableHtml += '</tr>';
        }
        
        tableHtml += '</tbody></table>';
        
        const formattedContent = tableHtml +
            '<div style="margin-top: 20px;">' +
            '<h3 style="font-size: 16px;">Analisi:</h3>' +
            '<div style="white-space: pre-wrap; line-height: 1.5; opacity: 0.85;">' +
            (analysisText || finalResponse) +
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
                model: 'claude-sonnet-4-20250514',
                processingMethod: 'document-search',
                chunksSearched: data.textChunks.length,
                questionsAnalyzed: questions.length,
                rawExtraction: responseText.substring(0, 2000) // DEBUG: mostra risposta raw
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
}