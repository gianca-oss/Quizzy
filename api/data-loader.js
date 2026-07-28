let enhancedDataCache = null;
let embeddingsCache = null;

// A table-of-contents line looks like "2.1 Il Global Compact . . . . . 19".
const TOC_LINE = /\.\s*\.\s*\.\s*\./;

/**
 * Table-of-contents chunks carry section titles and page numbers but no
 * actual content, yet they are keyword-dense enough to win retrieval slots
 * from real material (measured: 7.7% of all retrieved slots on the Marketing
 * corpus). Dropping them at load time costs nothing — no re-embedding, no
 * extra request work — and frees those slots for text that can answer.
 *
 * The corpus separates cleanly: 281/308 chunks have zero dotted lines and
 * the TOC ones sit at 0.89-1.00, so the 0.5 threshold has a wide margin.
 */
function isTableOfContents(chunk) {
    const lines = (chunk?.text || '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return false;
    const dotted = lines.filter(l => TOC_LINE.test(l)).length;
    return dotted / lines.length >= 0.5;
}

function dropTableOfContents(chunks, label) {
    const kept = chunks.filter(c => !isTableOfContents(c));
    const removed = chunks.length - kept.length;
    if (removed > 0) {
        console.log(`[Corpus] ${label}: rimossi ${removed} chunk di indice su ${chunks.length}`);
    }
    return kept;
}

// The active course comes from the environment and has NO default on purpose:
// a silent fallback meant that a missing or misspelled COURSE_NAME made the
// app answer a quiz with a different course's material, confidently and
// without any error. Failing loudly is the safer behaviour.
function getCourseName() {
    return process.env.COURSE_NAME || null;
}

function getGithubBase(courseName) {
    return `https://raw.githubusercontent.com/gianca-oss/Quizzy/main/data/processed/${courseName}/`;
}

async function loadTextChunks(baseUrl, totalFiles) {
    const chunks = [];

    for (let i = 0; i < totalFiles; i++) {
        try {
            const response = await fetch(baseUrl + `chunks_${i}.json`);
            if (response.ok) {
                const fileChunks = await response.json();
                chunks.push(...fileChunks);
            }
        } catch {
            if (i === 0) break;
        }
    }

    return chunks;
}

async function loadEnhancedData() {
    if (enhancedDataCache) return enhancedDataCache;

    const courseName = getCourseName();
    if (!courseName) {
        console.error('[Corpus] COURSE_NAME non configurata: nessun corso da caricare');
        return null;
    }
    const baseUrl = getGithubBase(courseName);

    try {
        const metadataResponse = await fetch(baseUrl + 'metadata.json');

        if (!metadataResponse.ok) {
            return loadFallbackChunks(baseUrl, courseName);
        }

        const metadata = await metadataResponse.json();
        const rawChunks = await loadTextChunks(baseUrl, metadata.stats?.totalFiles || 8);
        const textChunks = dropTableOfContents(rawChunks, 'text chunks');

        enhancedDataCache = {
            metadata,
            textChunks,
            version: metadata.version || '1.0',
            courseName: metadata.courseName || courseName
        };

        return enhancedDataCache;
    } catch {
        return loadFallbackChunks(baseUrl, courseName);
    }
}

async function loadFallbackChunks(baseUrl, courseName) {
    const chunks = await loadTextChunks(baseUrl, 8);
    return {
        metadata: { version: 'fallback', courseName },
        textChunks: dropTableOfContents(chunks, 'text chunks (fallback)'),
        version: '1.0-fallback'
    };
}

async function loadEmbeddings() {
    if (embeddingsCache) return embeddingsCache;

    const courseName = getCourseName();
    if (!courseName) return null;

    try {
        const response = await fetch(getGithubBase(courseName) + 'embeddings.json');
        if (!response.ok) return null;

        const data = await response.json();
        // Same filter as the text chunks: a TOC chunk has an embedding too and
        // would otherwise keep winning slots on the semantic path.
        data.chunks = dropTableOfContents(data.chunks || [], 'embeddings');
        embeddingsCache = data;
        return embeddingsCache;
    } catch {
        return null;
    }
}

module.exports = { loadEnhancedData, loadEmbeddings, isTableOfContents, getCourseName };
