const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMS = 512;
// How many chunks we retrieve per question. The context builder consumes
// whatever it receives, so this is the single place that decides the depth.
const CHUNKS_PER_QUESTION = 4;

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
 * Embed several texts with a SINGLE OpenAI call.
 *
 * The API accepts an array as `input` and returns one vector per element,
 * so a 20-question quiz costs one round-trip instead of twenty sequential
 * ones. Returns an array aligned with `texts`, or null if unavailable.
 */
async function getQueryEmbeddings(texts) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !texts.length) return null;

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: texts,
                dimensions: EMBEDDING_DIMS
            })
        });

        if (!response.ok) return null;

        const data = await response.json();
        if (!Array.isArray(data?.data)) return null;

        // The API may return items out of order — realign on `index`.
        const out = new Array(texts.length).fill(null);
        data.data.forEach(item => {
            const i = typeof item.index === 'number' ? item.index : 0;
            out[i] = item.embedding;
        });
        return out;
    } catch {
        return null;
    }
}

function buildQueryText(question) {
    const options = question.options ? Object.values(question.options).join(' ') : '';
    return `${question.text} ${options}`.trim();
}

/**
 * Rank all course chunks against one query embedding (pure CPU, ~0.25ms
 * per question over 300 chunks — measured, not a bottleneck).
 *
 * `sectionById` re-attaches the section title: embeddings.json only stores
 * id/text/keywords, so without this join every semantic hit would reach the
 * prompt without a citable section and the model could not honour the
 * "[Sez. X.Y]" instruction.
 */
function rankChunks(queryEmbedding, embeddingsData, topK, sectionById) {
    const similarities = embeddingsData.chunks.map(chunk => ({
        chunk,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    similarities.sort((a, b) => b.similarity - a.similarity);

    return similarities.slice(0, topK).map(s => ({
        chunk: {
            id: s.chunk.id,
            text: s.chunk.text,
            section: s.chunk.section || sectionById?.get(s.chunk.id),
            page: s.chunk.page,
            pages: s.chunk.pages,
            keywords: s.chunk.keywords
        },
        score: Math.round(s.similarity * 100),
        similarity: s.similarity,
        page: s.chunk.page
    }));
}

// id -> section, built once per request from the text chunks (which do carry
// the section) so semantic hits can be labelled for citation.
function buildSectionIndex(chunks) {
    const map = new Map();
    (chunks || []).forEach(c => {
        if (c?.id && c.section) map.set(c.id, c.section);
    });
    return map;
}

// Kept for backwards compatibility / single-question callers.
async function semanticSearch(questionText, options, embeddingsData, topK = CHUNKS_PER_QUESTION) {
    const embeddings = await getQueryEmbeddings([buildQueryText({ text: questionText, options })]);
    if (!embeddings?.[0]) return null;
    return rankChunks(embeddings[0], embeddingsData, topK);
}

const STOP_WORDS = ['della', 'delle', 'sono', 'quale', 'quali', 'come'];
const MIN_KEYWORD_SCORE = 30;
const MIN_KEYWORD_MATCHES = 3;

function keywordSearch(question, chunks) {
    const keywords = [];

    const questionWords = question.text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !STOP_WORDS.includes(word));

    keywords.push(...questionWords);

    Object.values(question.options || {}).forEach(option => {
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

        if (matchCount >= MIN_KEYWORD_MATCHES && score >= MIN_KEYWORD_SCORE) {
            matches.push({ chunk, score, matchCount, page: chunk.page });
        }
    });

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 3);
}

/**
 * Retrieve context for every question.
 *
 * All query embeddings are fetched in ONE batched call; the per-question
 * ranking that follows is synchronous. Questions whose semantic search
 * yields nothing fall back to keyword search individually.
 */
async function hybridSearch(questions, chunks, embeddingsData) {
    const canUseSemantic = !!embeddingsData?.chunks?.length && !!process.env.OPENAI_API_KEY;

    let queryEmbeddings = null;
    if (canUseSemantic) {
        const t0 = Date.now();
        queryEmbeddings = await getQueryEmbeddings(questions.map(buildQueryText));
        if (queryEmbeddings) {
            console.log(`[Search] ${questions.length} query embeddings in 1 batched call (${Date.now() - t0}ms)`);
        } else {
            console.warn('[Search] Batched embedding failed — falling back to keyword search');
        }
    }

    const sectionById = buildSectionIndex(chunks);

    return questions.map((question, i) => {
        let matches = [];

        if (queryEmbeddings?.[i]) {
            matches = rankChunks(queryEmbeddings[i], embeddingsData, CHUNKS_PER_QUESTION, sectionById);
        }

        if (matches.length === 0) {
            matches = keywordSearch(question, chunks);
        }

        return {
            question,
            matches,
            searchMethod: matches.length > 0 && matches[0].similarity ? 'semantic' : 'keyword'
        };
    });
}

module.exports = {
    hybridSearch,
    keywordSearch,
    semanticSearch,
    getQueryEmbeddings,
    CHUNKS_PER_QUESTION
};
