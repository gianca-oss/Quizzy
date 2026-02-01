#!/usr/bin/env node
// scripts/process-course.js - Script CLI per processare PDF di corsi
// Uso: node scripts/process-course.js <nome-corso>
// Esempio: node scripts/process-course.js strategia-internazionalizzazione

const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');

// Configurazione base
const CONFIG = {
    CHUNK_SIZE: 1500,
    CHUNK_OVERLAP: 300,
    MIN_PAGE_LENGTH: 50,
    CHUNKS_PER_FILE: 50,
    TOP_KEYWORDS: 5
};

// Pattern titoli configurabili per corso
// Ogni corso può avere pattern specifici in data/source/<corso>/config.json
const DEFAULT_TITLE_PATTERNS = [
    // Header pagina generici
    { regex: /EMBA\s*-\s*[A-Za-z\s]+\d+/g, replacement: '\n[HEADER] $&\n', level: 0 },

    // Numerazione gerarchica (es. "1. Titolo", "1.1. Titolo")
    { regex: /(\s)(\d+\.\s+[A-Z][A-Za-zàèéìòùÀÈÉÌÒÙ\s]{3,50})(?=\s[A-Z]|\s[Qq]uesto|\s[Ii]l|\s[Ll]a|\s[Uu]n)/g, replacement: '\n[H2] $2\n', level: 2 },
    { regex: /(\s)(\d+\.\d+\.?\s+[A-Z][A-Za-zàèéìòùÀÈÉÌÒÙ\s]{3,40})(?=\s[A-Z]|\s[Qq]uesto|\s[Ii]l|\s[Ll]a|\s[Uu]n)/g, replacement: '\n[H3] $2\n', level: 3 },
    { regex: /(\s)(\d+\.\d+\.\d+\.?\s+[A-Z][A-Za-zàèéìòùÀÈÉÌÒÙ\s]{3,40})(?=\s)/g, replacement: '\n[H4] $2\n', level: 4 },

    // Capitoli/Parti/Moduli espliciti
    { regex: /(CAPITOLO|Capitolo|CAP\.?)\s*\d+[:\s]+[A-Za-z].{5,50}/gi, replacement: '\n[H1] $&\n', level: 1 },
    { regex: /(PARTE|Parte)\s+[IVX\d]+[:\s]+[A-Za-z].{5,50}/gi, replacement: '\n[H1] $&\n', level: 1 },
    { regex: /(MODULO|Modulo)\s+\d+[:\s]+[A-Za-z].{5,50}/gi, replacement: '\n[H1] $&\n', level: 1 },
    { regex: /(SEZIONE|Sezione)\s+\d+[:\s]+[A-Za-z].{5,50}/gi, replacement: '\n[H1] $&\n', level: 1 },
    { regex: /(LEZIONE|Lezione)\s+\d+[:\s]+[A-Za-z].{5,50}/gi, replacement: '\n[H2] $&\n', level: 2 },

    // Fig. e Tabella (riferimenti)
    { regex: /(Fig\.\s*\d+\s*[–-]\s*.{5,80})/g, replacement: '\n[FIG] $1\n', level: 0 },
    { regex: /(Tabella\s*\d+\s*[–-]\s*.{5,80})/gi, replacement: '\n[TAB] $1\n', level: 0 },
];

/**
 * Carica configurazione specifica del corso (se esiste)
 */
async function loadCourseConfig(sourceDir) {
    const configPath = path.join(sourceDir, 'config.json');
    try {
        const configData = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configData);
        console.log('📋 Configurazione corso caricata da config.json');
        return config;
    } catch {
        return null; // Usa default
    }
}

/**
 * Compila pattern da configurazione
 */
function compilePatterns(patternsConfig) {
    if (!patternsConfig) return DEFAULT_TITLE_PATTERNS;

    return patternsConfig.map(p => ({
        regex: new RegExp(p.regex, p.flags || 'g'),
        replacement: p.replacement,
        level: p.level
    }));
}

// Stop words italiane
const STOP_WORDS = new Set([
    'il', 'la', 'di', 'che', 'e', 'a', 'un', 'in', 'con', 'per', 'da', 'su',
    'i', 'le', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'dal', 'dalla',
    'nel', 'nella', 'sul', 'sulla', 'è', 'sono', 'questo', 'questa', 'non',
    'come', 'anche', 'più', 'essere', 'ha', 'hanno', 'gli', 'lo', 'una', 'uno'
]);

/**
 * Corregge parole spezzate da spazi errati nel PDF
 * Es: "ela bora ta" -> "elaborata", "sa ggezza" -> "saggezza"
 */
function fixBrokenWords(text) {
    let result = text;

    // Parole comuni italiane che NON devono essere unite
    const commonWords = new Set([
        'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
        'di', 'da', 'in', 'su', 'a', 'e', 'o', 'ma', 'se', 'che', 'chi',
        'con', 'per', 'tra', 'fra', 'non', 'più', 'già', 'può', 'qui',
        'del', 'dei', 'nel', 'sul', 'dal', 'al', 'col',
        'ora', 'poi', 'mai', 'cui', 'ciò', 'come', 'dove', 'sono', 'ha'
    ]);

    // FASE 0: Correggi pattern specifici comuni nei PDF italiani
    // Pattern: 2 lettere + spazio + consonante doppia o gruppo consonantico
    // Es: "sa ggezza" -> "saggezza", "co mportamento" -> "comportamento"
    result = result.replace(/\b([a-zA-ZàèéìòùÀÈÉÌÒÙ]{2}) ([bcdfghjklmnpqrstvwxz]{2}[a-zàèéìòù]+)\b/gi, (match, p1, p2) => {
        if (commonWords.has(p1.toLowerCase())) return match;
        return p1 + p2;
    });

    // FASE 1: Unisci frammenti corti separati da singolo spazio
    // Ripeti più volte per catturare catene lunghe come "ela bora ta"
    for (let i = 0; i < 8; i++) {
        result = result.replace(/\b([a-zA-ZàèéìòùÀÈÉÌÒÙ]{2,5}) ([a-zàèéìòù]{2,5})\b/g, (match, p1, p2) => {
            if (commonWords.has(p1.toLowerCase()) || commonWords.has(p2.toLowerCase())) {
                return match;
            }
            // Unisci solo se la combinazione sembra plausibile
            return p1 + p2;
        });
    }

    // FASE 2: Suffissi comuni separati da spazio
    const suffixPatterns = [
        // Suffissi verbali
        /(\w{2,}) (zione|zioni|mento|menti|tore|tori|trice|trici)\b/gi,
        /(\w{2,}) (ando|endo|ato|ata|ati|ate|ito|ita|iti|ite)\b/gi,
        /(\w{2,}) (are|ere|ire|anno|ebbe|ebbero)\b/gi,
        // Suffissi nominali/aggettivali
        /(\w{2,}) (bile|bili|mente|ità|età|ezza|anza|enza)\b/gi,
        /(\w{2,}) (ivo|iva|ivi|ive|ale|ali|ile|ili|ore|ori)\b/gi,
        /(\w{2,}) (tico|tica|tici|tiche|stico|stica)\b/gi,
        /(\w{2,}) (ente|enti|ante|anti|oso|osa|osi|ose)\b/gi,
        /(\w{2,}) (ismo|ista|isti|iste)\b/gi,
    ];

    for (const pattern of suffixPatterns) {
        result = result.replace(pattern, '$1$2');
    }

    // FASE 3: Prefissi comuni separati da spazio
    result = result.replace(/\b(pre|pro|con|dis|mis|sub|inter|intra|extra|super|auto|anti|contro|sotto|sopra|oltre|entro|fuori|dentro|dietro|dopo|prima) (\w{3,})/gi, '$1$2');

    // FASE 4: Unisci singole lettere isolate che dovrebbero essere parte di parola
    // Es: "a lla" -> "alla", "a ttra" -> "attra", "e laborare" -> "elaborare"
    result = result.replace(/\b([aeioAEIO]) ([a-z]{2,})\b/g, (match, p1, p2) => {
        // Solo se p2 inizia con ll, tt, rr, cc, etc. (raddoppio) o combinazioni comuni
        if (/^(ll|tt|rr|cc|pp|bb|dd|ff|gg|mm|nn|ss|vv|zz|la|le|sp|st|sc|str|spr)/.test(p2)) {
            return p1 + p2;
        }
        return match;
    });

    // FASE 5: Correggi spazi attorno ad apostrofi
    result = result.replace(/\s+'/g, "'");
    result = result.replace(/'\s+/g, "'");

    // FASE 6: Rimuovi doppi spazi residui
    result = result.replace(/ {2,}/g, ' ');

    return result;
}

/**
 * Pulisce e normalizza il testo
 */
function cleanText(text) {
    let cleaned = text
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[^\S\r\n]+/g, ' ')
        .trim();

    // Applica correzione parole spezzate
    cleaned = fixBrokenWords(cleaned);

    return cleaned;
}

/**
 * Rileva e formatta tabelle nel testo
 * Cerca pattern comuni: righe con separatori | o allineamenti multipli
 */
function detectAndFormatTables(text) {
    const lines = text.split('\n');
    const result = [];
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Rileva righe che sembrano tabelle (contengono | o tab multipli o spazi allineati)
        const isPipeTable = (line.match(/\|/g) || []).length >= 2;
        const isTabTable = (line.match(/\t/g) || []).length >= 2;
        const hasMultipleColumns = /\s{3,}/.test(line) && line.length > 30;

        const isTableRow = isPipeTable || isTabTable || hasMultipleColumns;

        if (isTableRow) {
            if (!inTable) {
                inTable = true;
                result.push('\n[TABELLA]');
            }
            // Normalizza la riga della tabella
            const normalizedRow = line
                .replace(/\|/g, ' | ')
                .replace(/\t+/g, ' | ')
                .replace(/\s{3,}/g, ' | ')
                .trim();
            tableRows.push(normalizedRow);
            result.push(normalizedRow);
        } else {
            if (inTable && tableRows.length > 0) {
                result.push('[/TABELLA]\n');
                inTable = false;
                tableRows = [];
            }
            result.push(line);
        }
    }

    if (inTable) {
        result.push('[/TABELLA]\n');
    }

    return result.join('\n');
}

// Variabile globale per i pattern (verrà impostata da processCourse)
let activeTitlePatterns = DEFAULT_TITLE_PATTERNS;

/**
 * Rileva titoli e intestazioni
 * Ritorna il testo con marcatori per i titoli
 * Usa i pattern configurati per il corso corrente
 */
function detectTitles(text) {
    let result = text;

    for (const pattern of activeTitlePatterns) {
        result = result.replace(pattern.regex, pattern.replacement);
    }

    // Pulizia: rimuovi newline multipli creati
    result = result.replace(/\n{3,}/g, '\n\n');

    return result;
}

/**
 * Estrae keyword importanti per l'indicizzazione
 */
function extractKeywords(text) {
    const words = text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !STOP_WORDS.has(word));

    const freq = {};
    words.forEach(word => {
        freq[word] = (freq[word] || 0) + 1;
    });

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word]) => word);
}

/**
 * Identifica sezioni e capitoli
 */
function identifySections(text) {
    const sections = [];
    const patterns = [
        /^capitolo\s+\d+/gim,
        /^sezione\s+\d+/gim,
        /^\d+\.\d+\s+[A-Z]/gm,
        /^parte\s+[IVX]+/gim,
        /^modulo\s+\d+/gim,
        /^lezione\s+\d+/gim,
        /^unità\s+\d+/gim
    ];

    patterns.forEach(pattern => {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
            sections.push({
                title: match[0],
                position: match.index
            });
        }
    });

    return sections.sort((a, b) => a.position - b.position);
}

/**
 * Crea chunks intelligenti dal testo completo
 * Gestisce sia PDF con separatori di pagina che senza
 */
function createSmartChunks(pages) {
    const chunks = [];

    // Se abbiamo poche "pagine" ma molto testo, dividi per dimensione
    const totalText = pages.map(p => p.text).join('\n');
    const avgPageSize = totalText.length / pages.length;

    // Se la media è > 10K caratteri per pagina, il PDF non ha separatori reali
    const needsManualSplit = avgPageSize > 10000;

    if (needsManualSplit) {
        console.log('  ℹ️  PDF senza separatori pagina, chunking per dimensione...');
        return createChunksBySize(totalText);
    }

    // Chunking normale per PDF con pagine separate
    let currentChunk = '';
    let currentPages = [];
    let chunkTopics = new Set();

    for (const page of pages) {
        const pageText = `\n[Pagina ${page.page}]\n${page.text}\n`;
        const pageKeywords = extractKeywords(page.text);
        pageKeywords.forEach(kw => chunkTopics.add(kw));

        if (currentChunk.length + pageText.length > CONFIG.CHUNK_SIZE && currentChunk.length > 0) {
            chunks.push({
                id: `chunk_${chunks.length}`,
                text: currentChunk.trim(),
                pages: [...currentPages],
                startPage: currentPages[0],
                endPage: currentPages[currentPages.length - 1],
                topics: Array.from(chunkTopics).slice(0, 10),
                keywords: extractKeywords(currentChunk),
                length: currentChunk.length
            });

            const overlapText = currentChunk.slice(-CONFIG.CHUNK_OVERLAP);
            currentChunk = overlapText + pageText;
            currentPages = [page.page];
            chunkTopics = new Set(pageKeywords);
        } else {
            currentChunk += pageText;
            currentPages.push(page.page);
        }
    }

    if (currentChunk.trim()) {
        chunks.push({
            id: `chunk_${chunks.length}`,
            text: currentChunk.trim(),
            pages: [...currentPages],
            startPage: currentPages[0],
            endPage: currentPages[currentPages.length - 1],
            topics: Array.from(chunkTopics).slice(0, 10),
            keywords: extractKeywords(currentChunk),
            length: currentChunk.length
        });
    }

    return chunks;
}

/**
 * Crea chunks per dimensione fissa (per PDF senza separatori pagina)
 * Cerca di tagliare ai confini naturali (paragrafi, frasi)
 * Rispetta i confini di tabelle e sezioni
 */
function createChunksBySize(text) {
    const chunks = [];
    let position = 0;
    let chunkNum = 0;

    while (position < text.length) {
        let endPos = position + CONFIG.CHUNK_SIZE;

        if (endPos < text.length) {
            const searchStart = Math.max(position + CONFIG.CHUNK_SIZE - 300, position);
            const searchEnd = Math.min(position + CONFIG.CHUNK_SIZE + 300, text.length);
            const searchText = text.slice(searchStart, searchEnd);

            // Priorità per i punti di taglio:
            // 1. Fine tabella [/TABELLA]
            // 2. Inizio nuovo titolo [H1], [H2], [TITOLO]
            // 3. Doppio a capo (fine paragrafo)
            // 4. Punto + spazio (fine frase)
            // 5. Singolo a capo

            let cutPoint = searchText.indexOf('[/TABELLA]');
            if (cutPoint !== -1) {
                cutPoint += 10; // Include il tag
            } else {
                // Cerca inizio titolo (taglia PRIMA del titolo)
                const titleMatch = searchText.match(/\n\[(H\d|TITOLO)\]/);
                if (titleMatch) {
                    cutPoint = titleMatch.index;
                } else {
                    cutPoint = searchText.lastIndexOf('\n\n');
                    if (cutPoint === -1) cutPoint = searchText.lastIndexOf('. ');
                    if (cutPoint === -1) cutPoint = searchText.lastIndexOf('\n');
                    if (cutPoint === -1) cutPoint = CONFIG.CHUNK_SIZE - (searchStart - position);
                }
            }

            endPos = searchStart + cutPoint + 1;

            // Evita di tagliare nel mezzo di una tabella
            const chunkCandidate = text.slice(position, endPos);
            const tableStart = chunkCandidate.lastIndexOf('[TABELLA]');
            const tableEnd = chunkCandidate.lastIndexOf('[/TABELLA]');
            if (tableStart > tableEnd) {
                // Siamo dentro una tabella, estendi fino alla fine
                const nextTableEnd = text.indexOf('[/TABELLA]', endPos);
                if (nextTableEnd !== -1 && nextTableEnd - position < CONFIG.CHUNK_SIZE * 2) {
                    endPos = nextTableEnd + 11;
                }
            }
        } else {
            endPos = text.length;
        }

        const chunkText = text.slice(position, endPos).trim();

        if (chunkText.length > 50) {
            const keywords = extractKeywordsLight(chunkText);

            // Rileva tipo di contenuto nel chunk
            const hasTable = chunkText.includes('[TABELLA]');
            const hasTitle = /\[(H\d|TITOLO)\]/.test(chunkText);

            // Estrai titolo principale del chunk se presente
            const titleMatch = chunkText.match(/\[(H\d|TITOLO)\]\s*(.+?)(?:\n|$)/);
            const chunkTitle = titleMatch ? titleMatch[2].trim() : null;

            chunks.push({
                id: `chunk_${chunkNum}`,
                text: chunkText,
                pages: [chunkNum + 1],
                startPage: chunkNum + 1,
                endPage: chunkNum + 1,
                topics: [],
                keywords: keywords,
                length: chunkText.length,
                hasTable: hasTable,
                hasTitle: hasTitle,
                title: chunkTitle
            });
            chunkNum++;

            if (chunkNum % 100 === 0) {
                console.log(`  Creati ${chunkNum} chunks...`);
            }
        }

        position = endPos;
    }

    return chunks;
}

/**
 * Versione leggera di extractKeywords (meno memoria)
 */
function extractKeywordsLight(text) {
    const words = text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 4 && !STOP_WORDS.has(word));

    const freq = {};
    for (const word of words) {
        freq[word] = (freq[word] || 0) + 1;
        if (Object.keys(freq).length > 100) break; // Limita memoria
    }

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);
}

/**
 * Crea indice semantico
 */
function createSemanticIndex(chunks) {
    const index = {
        keywords: {},
        topics: {},
        pageToChunks: {},
        statistics: {
            totalKeywords: 0,
            avgChunkSize: 0,
            topicDistribution: {}
        }
    };

    chunks.forEach(chunk => {
        chunk.keywords.forEach(keyword => {
            if (!index.keywords[keyword]) {
                index.keywords[keyword] = [];
            }
            index.keywords[keyword].push({
                chunkId: chunk.id,
                pages: chunk.pages,
                relevance: chunk.keywords.indexOf(keyword) + 1
            });
        });

        chunk.topics.forEach(topic => {
            if (!index.topics[topic]) {
                index.topics[topic] = [];
            }
            index.topics[topic].push(chunk.id);
            index.statistics.topicDistribution[topic] =
                (index.statistics.topicDistribution[topic] || 0) + 1;
        });

        chunk.pages.forEach(page => {
            if (!index.pageToChunks[page]) {
                index.pageToChunks[page] = [];
            }
            index.pageToChunks[page].push(chunk.id);
        });
    });

    index.statistics.totalKeywords = Object.keys(index.keywords).length;
    index.statistics.avgChunkSize =
        chunks.reduce((sum, c) => sum + c.length, 0) / chunks.length;

    return index;
}

/**
 * Funzione principale di processing
 */
async function processCourse(courseName) {
    const baseDir = path.resolve(__dirname, '..');
    const sourceDir = path.join(baseDir, 'data', 'source', courseName);
    const outputDir = path.join(baseDir, 'data', 'processed', courseName);

    // Trova il PDF sorgente
    const sourceFiles = await fs.readdir(sourceDir).catch(() => []);
    const pdfFile = sourceFiles.find(f => f.toLowerCase().endsWith('.pdf'));

    if (!pdfFile) {
        console.error(`\n❌ Nessun file PDF trovato in: ${sourceDir}`);
        console.error(`   Assicurati di avere un file .pdf nella cartella.\n`);
        process.exit(1);
    }

    const inputPdf = path.join(sourceDir, pdfFile);

    console.log('\n' + '='.repeat(60));
    console.log(`📚 PROCESSING CORSO: ${courseName}`);
    console.log('='.repeat(60));
    console.log(`📄 File PDF: ${pdfFile}`);
    console.log(`📁 Output: ${outputDir}\n`);

    // Carica configurazione specifica del corso (se esiste)
    const courseConfig = await loadCourseConfig(sourceDir);
    if (courseConfig?.titlePatterns) {
        activeTitlePatterns = compilePatterns(courseConfig.titlePatterns);
        console.log(`📋 Caricati ${activeTitlePatterns.length} pattern titoli personalizzati\n`);
    } else {
        activeTitlePatterns = DEFAULT_TITLE_PATTERNS;
    }

    try {
        // Carica PDF
        console.log('📖 Caricamento PDF...');
        const pdfBuffer = await fs.readFile(inputPdf);
        const pdfData = await pdfParse(pdfBuffer, {
            max: 0,
            version: 'v2.0.550'
        });

        console.log(`✅ PDF caricato: ${pdfData.numpages} pagine\n`);

        // Estrai testo per pagina
        console.log('📄 Estrazione, pulizia e correzione testo...');
        const pages = [];
        const pageTexts = pdfData.text.split(/\f/);

        let processedPages = 0;
        let totalChars = 0;

        for (let i = 0; i < pageTexts.length; i++) {
            // cleanText ora include anche fixBrokenWords
            let cleanedText = cleanText(pageTexts[i]);

            // Applica riconoscimento tabelle e titoli
            cleanedText = detectAndFormatTables(cleanedText);
            cleanedText = detectTitles(cleanedText);

            if (cleanedText.length > CONFIG.MIN_PAGE_LENGTH) {
                pages.push({
                    page: i + 1,
                    text: cleanedText,
                    length: cleanedText.length,
                    sections: identifySections(cleanedText),
                    hasTables: cleanedText.includes('[TABELLA]'),
                    hasTitles: cleanedText.includes('[H1]') || cleanedText.includes('[H2]') || cleanedText.includes('[TITOLO]')
                });
                totalChars += cleanedText.length;
                processedPages++;
            }

            if ((i + 1) % 50 === 0) {
                console.log(`  Processate ${i + 1}/${pageTexts.length} pagine...`);
            }
        }

        console.log(`✅ Estratte ${processedPages} pagine con contenuto`);
        console.log(`   Caratteri totali: ${totalChars.toLocaleString()}\n`);

        // Crea chunks
        console.log('🔪 Creazione chunks...');
        const chunks = createSmartChunks(pages);
        console.log(`✅ Creati ${chunks.length} chunks\n`);

        // Crea indice semantico
        console.log('🧠 Creazione indice semantico...');
        const semanticIndex = createSemanticIndex(chunks);
        console.log(`✅ Indicizzate ${semanticIndex.statistics.totalKeywords} keywords\n`);

        // Crea directory output
        await fs.mkdir(outputDir, { recursive: true });

        // Salva chunks
        console.log('💾 Salvataggio chunks...');
        const numFiles = Math.ceil(chunks.length / CONFIG.CHUNKS_PER_FILE);

        for (let i = 0; i < numFiles; i++) {
            const start = i * CONFIG.CHUNKS_PER_FILE;
            const end = Math.min(start + CONFIG.CHUNKS_PER_FILE, chunks.length);
            const fileChunks = chunks.slice(start, end);

            const compactChunks = fileChunks.map(chunk => ({
                id: chunk.id,
                text: chunk.text,
                page: chunk.startPage,
                pages: chunk.pages,
                keywords: chunk.keywords.slice(0, CONFIG.TOP_KEYWORDS)
            }));

            const filename = path.join(outputDir, `chunks_${i}.json`);
            await fs.writeFile(filename, JSON.stringify(compactChunks, null, 2));

            const stats = await fs.stat(filename);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`  ✅ chunks_${i}.json (${fileChunks.length} chunks, ${sizeMB}MB)`);
        }

        // Salva metadata
        console.log('\n💾 Salvataggio metadata...');
        const metadata = {
            version: '1.0',
            courseName: courseName,
            sourceFile: pdfFile,
            processedAt: new Date().toISOString(),
            stats: {
                totalPages: pdfData.numpages,
                pagesWithContent: processedPages,
                totalChunks: chunks.length,
                totalCharacters: totalChars,
                avgChunkSize: Math.round(semanticIndex.statistics.avgChunkSize),
                totalKeywords: semanticIndex.statistics.totalKeywords,
                totalFiles: numFiles
            },
            config: CONFIG,
            topTopics: Object.entries(semanticIndex.statistics.topicDistribution)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([topic, count]) => ({ topic, count }))
        };

        await fs.writeFile(
            path.join(outputDir, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
        );

        // Salva indice semantico
        console.log('💾 Salvataggio indice semantico...');
        const compactIndex = {
            keywords: Object.fromEntries(
                Object.entries(semanticIndex.keywords)
                    .slice(0, 1000)
                    .map(([k, v]) => [k, v.slice(0, 10)])
            ),
            pageToChunks: semanticIndex.pageToChunks,
            statistics: semanticIndex.statistics
        };

        await fs.writeFile(
            path.join(outputDir, 'search-index.json'),
            JSON.stringify(compactIndex, null, 2)
        );

        // Statistiche aggiuntive
        const chunksWithTables = chunks.filter(c => c.hasTable).length;
        const chunksWithTitles = chunks.filter(c => c.hasTitle).length;
        const titles = chunks.filter(c => c.title).map(c => c.title);

        // Report finale
        console.log('\n' + '='.repeat(60));
        console.log('✅ PROCESSING COMPLETATO!');
        console.log('='.repeat(60));
        console.log('\n📊 RIEPILOGO:');
        console.log(`  📄 Pagine totali: ${pdfData.numpages}`);
        console.log(`  📝 Pagine con contenuto: ${processedPages}`);
        console.log(`  📦 Chunks creati: ${chunks.length}`);
        console.log(`  📋 Chunks con tabelle: ${chunksWithTables}`);
        console.log(`  📑 Chunks con titoli: ${chunksWithTitles}`);
        console.log(`  🔑 Keywords indicizzate: ${semanticIndex.statistics.totalKeywords}`);
        console.log(`  💾 Output: ${outputDir}\n`);

        console.log('🎯 TOP 10 ARGOMENTI:');
        metadata.topTopics.slice(0, 10).forEach((topic, i) => {
            console.log(`  ${i + 1}. ${topic.topic} (${topic.count})`);
        });
        console.log('');

        return metadata;

    } catch (error) {
        console.error('\n❌ Errore durante il processing:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// CLI
if (require.main === module) {
    const courseName = process.argv[2];

    if (!courseName) {
        console.log(`
📚 Process Course - Script per processare PDF di corsi

USO:
  node scripts/process-course.js <nome-corso>

ESEMPIO:
  node scripts/process-course.js strategia-internazionalizzazione

STRUTTURA RICHIESTA:
  data/source/<nome-corso>/source.pdf  (o qualsiasi .pdf)

OUTPUT:
  data/processed/<nome-corso>/
    ├── chunks_0.json       (chunks di testo)
    ├── metadata.json       (metadati)
    └── search-index.json   (indice ricerca)
`);
        process.exit(1);
    }

    processCourse(courseName).catch(console.error);
}

module.exports = { processCourse, CONFIG };
