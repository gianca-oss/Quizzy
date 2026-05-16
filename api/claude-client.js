const MAX_RETRIES = 3;

async function callWithRetry(url, options) {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await fetch(url, options);

            if (response.status === 429) {
                const waitTime = Math.min(Math.pow(2, i) * 2000, 15000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('API Key non valida o mancante');
                }
                if (i < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }

            return response;
        } catch (error) {
            if (i === MAX_RETRIES - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
    };
}

async function extractQuestions(apiKey, imageContent, prompt) {
    const response = await callWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [imageContent, { type: 'text', text: prompt }]
            }]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Errore API Claude (${response.status})`;
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorData.message || errorMessage;
        } catch {
            errorMessage += `: ${errorText.substring(0, 200)}`;
        }
        throw new Error(errorMessage);
    }

    const data = await response.json();
    if (!data?.content?.[0]) {
        throw new Error('Risposta API incompleta');
    }

    return data.content[0].text;
}

async function analyzeWithContext(apiKey, prompt) {
    const response = await callWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify({
            model: 'claude-opus-4-20250514',
            max_tokens: 4000,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: prompt }]
            }]
        })
    });

    if (!response.ok) {
        throw new Error('Errore nell\'analisi finale delle domande');
    }

    const data = await response.json();
    return data.content[0].text;
}

module.exports = { extractQuestions, analyzeWithContext };
