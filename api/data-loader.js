let enhancedDataCache = null;
let embeddingsCache = null;

function getGithubBase() {
    const courseName = process.env.COURSE_NAME || 'strategia-internazionalizzazione';
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

    const baseUrl = getGithubBase();
    const courseName = process.env.COURSE_NAME || 'strategia-internazionalizzazione';

    try {
        const metadataResponse = await fetch(baseUrl + 'metadata.json');

        if (!metadataResponse.ok) {
            return loadFallbackChunks(baseUrl, courseName);
        }

        const metadata = await metadataResponse.json();
        const textChunks = await loadTextChunks(baseUrl, metadata.stats?.totalFiles || 8);

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
        textChunks: chunks,
        version: '1.0-fallback'
    };
}

async function loadEmbeddings() {
    if (embeddingsCache) return embeddingsCache;

    try {
        const response = await fetch(getGithubBase() + 'embeddings.json');
        if (!response.ok) return null;

        embeddingsCache = await response.json();
        return embeddingsCache;
    } catch {
        return null;
    }
}

module.exports = { loadEnhancedData, loadEmbeddings };
