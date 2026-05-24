const MAX_RETRIES = 3;

const MODELS = {
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'claude-opus-4-20250514'
};

// Errors that won't be fixed by retrying — bail immediately to save cost & time.
function isPermanentError(status, body) {
    if (status === 401 || status === 402 || status === 403) return true;
    if (status === 400 && body) {
        const lower = body.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) return true;
        if (lower.includes('invalid_api_key') || lower.includes('authentication')) return true;
    }
    return false;
}

async function callWithRetry(url, options) {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await fetch(url, options);

            // Don't retry permanent errors — peek at body once
            if (!response.ok) {
                const cloned = response.clone();
                const body = await cloned.text();
                if (isPermanentError(response.status, body)) {
                    return new Response(body, { status: response.status, statusText: response.statusText });
                }
            }

            if (response.status === 429) {
                const waitTime = Math.min(Math.pow(2, i) * 2000, 15000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            // Only retry on 5xx (transient server issues)
            if (response.status >= 500 && response.status < 600) {
                if (i < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }

            return response;
        } catch (error) {
            // Network error — retry
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

async function extractQuestions(apiKey, imageContent, prompt, modelKey = 'sonnet') {
    const model = MODELS[modelKey] || MODELS.sonnet;
    const response = await callWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify({
            model,
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
        let errorKind = 'unknown';
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorData.message || errorMessage;
        } catch {
            errorMessage += `: ${errorText.substring(0, 200)}`;
        }
        // Tag known permanent error categories so callers can react
        const lower = errorMessage.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) errorKind = 'no_credits';
        else if (lower.includes('invalid_api_key') || lower.includes('authentication')) errorKind = 'auth';
        else if (response.status === 429) errorKind = 'rate_limit';
        const err = new Error(errorMessage);
        err.kind = errorKind;
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    if (!data?.content?.[0]) {
        throw new Error('Risposta API incompleta');
    }

    return data.content[0].text;
}

async function analyzeWithContext(apiKey, prompt, modelKey = 'sonnet') {
    const model = MODELS[modelKey] || MODELS.sonnet;
    const response = await callWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify({
            model,
            max_tokens: 4000,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [{ type: 'text', text: prompt }]
            }]
        })
    });

    if (!response.ok) {
        const body = await response.text();
        let errorMessage = `Errore API Claude (${response.status})`;
        let errorKind = 'unknown';
        try {
            const parsed = JSON.parse(body);
            errorMessage = parsed.error?.message || parsed.message || errorMessage;
        } catch {}
        const lower = errorMessage.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) errorKind = 'no_credits';
        else if (lower.includes('invalid_api_key') || lower.includes('authentication')) errorKind = 'auth';
        else if (response.status === 429) errorKind = 'rate_limit';
        const err = new Error(errorMessage);
        err.kind = errorKind;
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    return { text: data.content[0].text, model };
}

module.exports = { extractQuestions, analyzeWithContext };
