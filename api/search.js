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

async function getQueryEmbedding(text) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return null;

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

        if (!response.ok) return null;

        const data = await response.json();
        return data.data[0].embedding;
    } catch {
        return null;
    }
}

async function semanticSearch(questionText, options, embeddingsData, topK = 3) {
    const queryText = `${questionText} ${Object.values(options).join(' ')}`;
    const queryEmbedding = await getQueryEmbedding(queryText);
    if (!queryEmbedding) return null;

    const similarities = embeddingsData.chunks.map(chunk => ({
        chunk,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    similarities.sort((a, b) => b.similarity - a.similarity);

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

        if (matchCount >= MIN_KEYWORD_MATCHES && score >= MIN_KEYWORD_SCORE) {
            matches.push({ chunk, score, matchCount, page: chunk.page });
        }
    });

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 3);
}

async function hybridSearch(questions, chunks, embeddingsData) {
    const results = [];
    const useSemanticSearch = !!embeddingsData && !!process.env.OPENAI_API_KEY;

    for (const question of questions) {
        let matches = [];

        if (useSemanticSearch) {
            const semanticMatches = await semanticSearch(
                question.text, question.options, embeddingsData, 5
            );
            if (semanticMatches && semanticMatches.length > 0) {
                matches = semanticMatches;
            }
        }

        if (matches.length === 0) {
            matches = keywordSearch(question, chunks);
        }

        results.push({
            question,
            matches,
            searchMethod: matches.length > 0 && matches[0].similarity ? 'semantic' : 'keyword'
        });
    }

    return results;
}

module.exports = { hybridSearch, keywordSearch, semanticSearch };
