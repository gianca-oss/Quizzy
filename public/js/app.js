let images = [];

const HISTORY_KEY = 'quizzy_history';
const PRECISION_KEY = 'quizzy_precision';
const MAX_HISTORY = 50;
const RETRY_DELAYS = [2000, 5000]; // up to 3 attempts total for transient errors

// HTTP codes that mean "don't bother retrying — fix the cause first"
const PERMANENT_STATUSES = new Set([400, 401, 402, 403, 404, 422]);

async function fetchWithRetry(url, options, onRetry) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
            const response = await fetch(url, options);
            // Permanent error → bail without retrying
            if (PERMANENT_STATUSES.has(response.status)) {
                return response;
            }
            // Transient server error → retry
            if (response.status >= 500 && response.status < 600) {
                lastError = new Error(`HTTP ${response.status}`);
                if (attempt < RETRY_DELAYS.length) {
                    if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length + 1);
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                    continue;
                }
                return response;
            }
            return response;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            lastError = err;
            if (attempt < RETRY_DELAYS.length) {
                if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length + 1);
                await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
                continue;
            }
        }
    }
    throw lastError;
}

// Warm Railway with a tiny GET request before posting the heavy image — this
// often makes the first real request hit a warm container.
async function warmupBackend() {
    try {
        await fetch('/api/analyze', { method: 'GET', cache: 'no-store' });
    } catch {
        // Best-effort; ignore failures
    }
}

const imgUploadArea = document.getElementById('imgUploadArea');
const imgInput = document.getElementById('imgInput');
const imgLabel = document.getElementById('imgLabel');
const imgSublabel = document.getElementById('imgSublabel');
const imgStatus = document.getElementById('imgStatus');
const clearBtn = document.getElementById('clearBtn');
const historyBtn = document.getElementById('historyBtn');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsContent = document.getElementById('resultsContent');

function loadHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveToHistory(answers, analysis) {
    const history = loadHistory();
    history.unshift({
        id: Date.now(),
        date: new Date().toISOString(),
        questionsCount: answers.length,
        answers,
        analysis
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        updateHistoryButton();
    } catch (err) {
        console.warn('Cannot save to history:', err.message);
    }
}

function updateHistoryButton() {
    if (!historyBtn) return;
    const count = loadHistory().length;
    historyBtn.style.display = count > 0 ? 'inline-block' : 'none';
    historyBtn.textContent = count > 0 ? `Storico (${count})` : 'Storico';
}

function deleteHistoryItem(id) {
    const history = loadHistory().filter(h => h.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    updateHistoryButton();
    showHistory();
}

function clearHistory() {
    if (!confirm('Cancellare tutto lo storico?')) return;
    localStorage.removeItem(HISTORY_KEY);
    updateHistoryButton();
    backToUpload();
}

function formatHistoryDate(iso) {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Oggi, ${time}`;
    const date = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
    return `${date}, ${time}`;
}

let historyEditMode = false;

function showHistory() {
    const history = loadHistory();
    let html = '<div class="result-content history-view">';

    // Top bar: chevron-back · Storico · Modifica
    html += '<div class="history-topbar">';
    html += '<button class="history-topbar-btn back" onclick="backToUpload()" aria-label="Indietro">';
    html += '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    html += '<span>Indietro</span></button>';
    html += '<div class="history-title">Storico</div>';
    if (history.length > 0) {
        html += `<button class="history-topbar-btn edit" onclick="toggleHistoryEdit()">${historyEditMode ? 'Fine' : 'Modifica'}</button>`;
    } else {
        html += '<span class="history-topbar-btn-placeholder"></span>';
    }
    html += '</div>';

    if (history.length === 0) {
        html += '<div class="history-empty">Nessun quiz salvato</div>';
    } else {
        history.forEach(item => {
            html += `<div class="history-card${historyEditMode ? ' editing' : ''}">`;
            if (historyEditMode) {
                html += `<button class="history-delete-btn" onclick="event.stopPropagation();deleteHistoryItem(${item.id})" aria-label="Elimina">`;
                html += '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" fill="#ff3b30"/><rect x="6" y="11" width="12" height="2" fill="white" rx="1"/></svg>';
                html += '</button>';
            }
            html += `<div class="history-card-body" onclick="openHistoryItem(${item.id})">`;
            html += `<div class="history-badge">${item.questionsCount}</div>`;
            html += `<div class="history-card-info">`;
            html += `<div class="history-card-title">${formatHistoryDate(item.date)}</div>`;
            html += `<div class="history-card-sub">${item.questionsCount} domande</div>`;
            html += `</div>`;
            html += `<button class="history-share-inline" onclick="event.stopPropagation();shareHistoryItem(${item.id})" aria-label="Condividi">`;
            html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
            html += '</button>';
            html += '<div class="history-chevron">›</div>';
            html += '</div></div>';
        });
    }

    // Bottom action bar appears only in edit mode
    if (historyEditMode && history.length > 0) {
        html += '<div class="history-edit-toolbar">';
        html += '<button onclick="importHistoryClick()">Importa</button>';
        html += '<button onclick="exportHistory()">Esporta</button>';
        html += '<button class="danger" onclick="clearHistory()">Cancella tutto</button>';
        html += '</div>';
    } else if (history.length === 0) {
        html += '<div class="history-edit-toolbar"><button onclick="importHistoryClick()">Importa</button></div>';
    }

    html += '<input type="file" id="historyImportInput" accept="application/json" style="display:none">';
    html += '</div>';

    resultsContent.innerHTML = html;
    results.style.display = 'block';
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.actions').style.display = 'none';
    const pt = document.getElementById('precisionToggle');
    if (pt) pt.style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleHistoryEdit() {
    historyEditMode = !historyEditMode;
    showHistory();
}

function openHistoryItem(id) {
    const item = loadHistory().find(h => h.id === id);
    if (!item) return;
    displayResults([{ answers: item.answers, analysis: item.analysis }], { skipSave: true });
}

async function exportHistory() {
    const history = loadHistory();
    if (!history.length) return;
    const payload = { app: 'quizzy', version: 1, exportedAt: new Date().toISOString(), history };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const fileName = `quizzy-storico-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], fileName, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: 'Storico Quizzy' });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importHistoryClick() {
    const input = document.getElementById('historyImportInput');
    if (!input) return;
    input.value = '';
    input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (file) importHistory(file);
    };
    input.click();
}

async function importHistory(file) {
    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const incoming = Array.isArray(payload) ? payload : payload.history;
        if (!Array.isArray(incoming)) throw new Error('Formato non valido');

        const valid = incoming.filter(it =>
            it && Array.isArray(it.answers) && typeof it.date === 'string'
        );
        if (!valid.length) throw new Error('Nessun quiz valido nel file');

        const existing = loadHistory();
        const existingIds = new Set(existing.map(h => h.id));
        const merged = [...existing];
        let added = 0;
        for (const it of valid) {
            if (!existingIds.has(it.id)) {
                merged.push(it);
                added++;
            }
        }
        merged.sort((a, b) => b.id - a.id);
        if (merged.length > MAX_HISTORY) merged.length = MAX_HISTORY;
        localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
        updateHistoryButton();
        showHistory();
        alert(`Importati ${added} quiz su ${valid.length} (i duplicati sono stati ignorati).`);
    } catch (err) {
        alert('Errore importazione: ' + err.message);
    }
}

function buildReportHtml(item) {
    const dateLabel = formatHistoryDate(item.date);
    const sourceLabels = { CITATO: 'CITATO', VERIFICATO: 'VERIFICATO', AI: 'AI' };

    let rows = '';
    item.answers.forEach(a => {
        const label = sourceLabels[a.source] || sourceLabels.AI;
        rows += `<tr><td>${a.num}</td><td><strong>${a.letter}</strong></td><td style="font-weight:700;color:#000">${label}</td></tr>`;
    });

    const analysisHtml = (item.analysis || '')
        .replace(/^([A-D]\).*?)\s*(?:\[CORRETTA\]|\(V\)|[✓✔])\s*$/gm, '<span style="color:#1a8d3a;font-weight:600">$1</span>')
        .replace(/\*\*(\d+\..+?)\*\*/g, '<strong style="display:inline-block;margin-top:6px">$1</strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\s*---\s*\n/g, '<hr style="margin:10px 0;border:none;border-top:1px solid #ddd">')
        .replace(/\n{2,}/g, '\n')
        .replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Quizzy Report - ${dateLabel}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; background: #fff; color: #111; max-width: 720px; margin: 0 auto; padding: 20px; line-height: 1.5; }
h1 { font-size: 22px; margin-bottom: 4px; }
.meta { color: #888; font-size: 13px; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
th, td { padding: 8px 10px; border: 1px solid #ddd; text-align: center; }
th { background: #f5f5f5; font-weight: 600; }
h2 { font-size: 16px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 16px; }
.analysis { font-size: 14px; }
hr { border: none; border-top: 1px dashed #ddd; margin: 16px 0; }
</style>
</head>
<body>
<h1>Quizzy - Risultati Quiz</h1>
<div class="meta">${dateLabel} · ${item.questionsCount} domande</div>
<table>
<thead><tr><th>N°</th><th>Risposta</th><th>Fonte</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>Analisi</h2>
<div class="analysis">${analysisHtml}</div>
</body>
</html>`;
}

async function shareHistoryItem(id) {
    const item = loadHistory().find(h => h.id === id);
    if (!item) return;

    const html = buildReportHtml(item);
    const blob = new Blob([html], { type: 'text/html' });
    const fileName = `quizzy-${new Date(item.date).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`;
    const file = new File([blob], fileName, { type: 'text/html' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: 'Quizzy Report' });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }

    // Fallback: download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupDragAndDrop(element, handler) {
    element.addEventListener('dragover', (e) => {
        e.preventDefault();
        element.classList.add('dragover');
    });
    element.addEventListener('dragleave', () => {
        element.classList.remove('dragover');
    });
    element.addEventListener('drop', (e) => {
        e.preventDefault();
        element.classList.remove('dragover');
        handler(e.dataTransfer.files);
    });
}

function handleImagesDrop(files) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
        handleImages({ target: { files: imageFiles } });
    }
}

function compressImage(file) {
    const isScreenshot = file.type === 'image/png';

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            // Screenshots (PNG): send as-is if under 5MB, already sharp
            if (isScreenshot && file.size < 5 * 1024 * 1024) {
                resolve(e.target.result.split(',')[1]);
                return;
            }

            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const maxDim = 1800;
                    const quality = 0.92;

                    let width = img.width;
                    let height = img.height;

                    if (width > height && width > maxDim) {
                        height = (maxDim / width) * height;
                        width = maxDim;
                    } else if (height > maxDim) {
                        width = (maxDim / height) * width;
                        height = maxDim;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);

                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    resolve(dataUrl.split(',')[1]);
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error('Impossibile caricare l\'immagine'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Errore lettura file'));
        reader.readAsDataURL(file);
    });
}

async function handleImages(e) {
    const files = Array.from(e.target.files);
    images = [];
    imgLabel.textContent = 'Elaborazione...';
    imgSublabel.textContent = 'Compressione immagini...';
    imgStatus.textContent = '';

    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.type.startsWith('image/')) continue;

            imgStatus.textContent = `Immagine ${i + 1} di ${files.length}`;
            images.push(await compressImage(file));
        }

        if (images.length > 0) {
            imgUploadArea.classList.add('loaded');
            imgLabel.textContent = `${images.length} ${images.length === 1 ? 'immagine' : 'immagini'}`;
            imgSublabel.textContent = 'Avvio analisi...';
            imgStatus.textContent = '';
            analyze();
            return;
        }
    } catch (err) {
        imgLabel.textContent = 'Errore';
        imgSublabel.textContent = err.message;
        images = [];
    }
}

function clearAll() {
    images = [];
    imgUploadArea.classList.remove('loaded');
    imgLabel.textContent = 'Seleziona immagini';
    imgSublabel.textContent = 'Puoi selezionare più file contemporaneamente';
    imgStatus.textContent = '';
    imgInput.value = '';
    results.style.display = 'none';
    resultsContent.innerHTML = '';
    document.querySelector('.main-content').style.display = 'block';
    document.querySelector('.actions').style.display = 'flex';
    const pt = document.getElementById('precisionToggle');
    if (pt) pt.style.display = 'flex';
}

function backToUpload() {
    images = [];
    imgInput.value = '';
    imgUploadArea.classList.remove('loaded');
    imgLabel.textContent = 'Seleziona immagini';
    imgSublabel.textContent = 'Puoi selezionare più file contemporaneamente';
    imgStatus.textContent = '';
    results.style.display = 'none';
    resultsContent.innerHTML = '';
    document.querySelector('.main-content').style.display = 'block';
    document.querySelector('.actions').style.display = 'flex';
    const pt = document.getElementById('precisionToggle');
    if (pt) pt.style.display = 'flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

const SOURCE_STYLES = {
    CITATO: { indicator: 'CITATO', color: '#ffffff' },
    VERIFICATO: { indicator: 'VERIFICATO', color: '#ffffff' },
    AI: { indicator: 'AI', color: '#ffffff' }
};

function formatSource(source) {
    const style = SOURCE_STYLES[source] || SOURCE_STYLES.AI;
    return `<span style="color: ${style.color}">${style.indicator}</span>`;
}

const PROGRESS_STEPS = [
    { text: 'Lettura immagine', pct: 8, delay: 0 },
    { text: 'Estrazione domande', pct: 30, delay: 2000 },
    { text: 'Ricerca nel materiale', pct: 55, delay: 8000 },
    { text: 'Analisi con AI', pct: 80, delay: 14000 },
    { text: 'Quasi fatto', pct: 92, delay: 30000 }
];

function buildProgressUI(count) {
    const container = document.getElementById('imageProgress');
    if (!container) return;
    container.innerHTML = '';
    const RING_SIZE = 48;
    const RING_STROKE = 5;
    const RING_R = (RING_SIZE - RING_STROKE) / 2;
    const RING_CIRC = 2 * Math.PI * RING_R;

    for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'img-row';
        row.id = `imgRow_${i}`;
        row.innerHTML = `
            <svg class="img-row-ring" width="${RING_SIZE}" height="${RING_SIZE}" viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
                <circle class="ring-track" cx="${RING_SIZE/2}" cy="${RING_SIZE/2}" r="${RING_R}" fill="none" stroke-width="${RING_STROKE}"/>
                <circle class="ring-fill" cx="${RING_SIZE/2}" cy="${RING_SIZE/2}" r="${RING_R}" fill="none" stroke-width="${RING_STROKE}"
                    stroke-linecap="round" transform="rotate(-90 ${RING_SIZE/2} ${RING_SIZE/2})"
                    stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${RING_CIRC}"/>
            </svg>
            <div class="img-row-info">
                <div class="img-row-name">Immagine ${i + 1}</div>
                <div class="img-row-status">In attesa</div>
            </div>
        `;
        // Store circumference on row for later updates
        row.dataset.circ = RING_CIRC;
        container.appendChild(row);
    }
}

function setImageState(index, status, pct, state = 'active') {
    const row = document.getElementById(`imgRow_${index}`);
    if (!row) return;
    row.classList.remove('active', 'done', 'error');
    if (state) row.classList.add(state);
    row.querySelector('.img-row-status').textContent = status;
    const fill = row.querySelector('.ring-fill');
    if (fill && pct != null) {
        const circ = parseFloat(row.dataset.circ);
        fill.style.strokeDashoffset = circ * (1 - pct / 100);
    }
}

function startProgressFeedback(imageIndex) {
    const timers = PROGRESS_STEPS.map(step =>
        setTimeout(() => setImageState(imageIndex, step.text, step.pct, 'active'), step.delay)
    );
    return () => timers.forEach(clearTimeout);
}

function hideMainView() {
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.actions').style.display = 'none';
    const pt = document.getElementById('precisionToggle');
    if (pt) pt.style.display = 'none';
}

async function analyzeOneImage(imageData, index, startNumber, precision) {
    const requestBody = {
        model: 'claude-3-haiku-20240307',
        max_tokens: 4000,
        startNumber,
        precision,
        messages: [{
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } }]
        }]
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);

    try {
        const response = await fetchWithRetry('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        }, (attempt, total) => setImageState(index, `Ritento (${attempt}/${total - 1})...`, null, 'active'));

        clearTimeout(timeoutId);

        if (!response.ok) {
            const text = await response.text();
            let kind = 'unknown';
            let message = `HTTP ${response.status}`;
            try {
                const parsed = JSON.parse(text);
                kind = parsed.kind || 'unknown';
                message = parsed.error || message;
            } catch {
                message = `${message}: ${text.substring(0, 100)}`;
            }
            const err = new Error(message);
            err.kind = kind;
            err.status = response.status;
            throw err;
        }
        return await response.json();
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

async function analyze() {
    if (images.length === 0) return;
    if (!navigator.onLine) {
        showOfflineWarning();
        return;
    }

    buildProgressUI(images.length);
    loading.classList.add('show');
    results.style.display = 'none';
    resultsContent.innerHTML = '';

    // Pre-warm Railway so the first POST has a better chance of hitting
    // a warm container (cuts cold-start failures dramatically).
    warmupBackend();

    const allResults = [];
    const failedIndexes = [];
    let questionStartNumber = 1;
    const precision = document.getElementById('precisionInput')?.checked === true;

    let permanentErrorKind = null;
    for (let i = 0; i < images.length; i++) {
        const stopProgress = startProgressFeedback(i);
        try {
            const data = await analyzeOneImage(images[i], i, questionStartNumber, precision);
            stopProgress();
            const qCount = data.metadata?.questionsAnalyzed || 0;
            setImageState(i, `Completata · ${qCount} domande`, 100, 'done');
            allResults.push({ answers: data.answers || [], analysis: data.analysis || '' });
            questionStartNumber += qCount;
        } catch (err) {
            stopProgress();
            const isPermanent = err.kind && err.kind !== 'unknown';
            let label;
            if (err.kind === 'no_credits') label = 'Credito Anthropic esaurito';
            else if (err.kind === 'auth') label = 'API Key non valida';
            else if (err.kind === 'rate_limit') label = 'Rate limit superato';
            else if (err.name === 'AbortError') label = 'Timeout server';
            else label = (err.message || 'Errore sconosciuto').substring(0, 60);
            setImageState(i, label, 100, 'error');
            failedIndexes.push(i);
            if (isPermanent) {
                permanentErrorKind = err.kind;
                // Don't waste credits on the remaining images
                for (let j = i + 1; j < images.length; j++) {
                    setImageState(j, 'Saltata', 100, 'error');
                    failedIndexes.push(j);
                }
                break;
            }
        }
    }

    loading.classList.remove('show');

    if (allResults.length > 0) {
        displayResults(allResults, { failedCount: failedIndexes.length });
    } else {
        const totalImages = images.length;
        imgLabel.textContent = 'Seleziona immagini';
        imgSublabel.textContent = 'Puoi selezionare più file contemporaneamente';
        imgUploadArea.classList.remove('loaded');
        imgInput.value = '';
        images = [];

        // Tailored messages per error type
        let title, body, note;
        if (permanentErrorKind === 'no_credits') {
            title = 'Credito Anthropic esaurito';
            body = "L'API key configurata su Railway ha esaurito i crediti.";
            note = 'Vai su <a href="https://platform.claude.com" target="_blank" style="color:#ffcc00">platform.claude.com → Billing</a> e ricarica per riprendere a usare l\'app.';
        } else if (permanentErrorKind === 'auth') {
            title = 'API Key non valida';
            body = "L'API key Anthropic configurata su Railway non è valida o è stata revocata.";
            note = 'Aggiorna la variabile <code>ANTHROPIC_API_KEY_EVO</code> nelle Variables di Railway.';
        } else if (permanentErrorKind === 'rate_limit') {
            title = 'Limite di velocità superato';
            body = "Troppe richieste in poco tempo verso Anthropic.";
            note = 'Aspetta qualche minuto e riprova.';
        } else {
            title = 'Nessuna immagine analizzata';
            body = totalImages === 1 ? "L'analisi è fallita." : `Tutte le ${totalImages} analisi sono fallite.`;
            note = 'Railway potrebbe essere in cold-start. Riprova tra qualche secondo.';
        }

        resultsContent.innerHTML = `
            <div class="error-message">
                <div class="error-title">${title}</div>
                <div class="error-content">
                    <strong>${body}</strong>
                    <div class="error-note">${note}</div>
                    <div style="text-align: center; margin-top: 16px;">
                        <button onclick="backToUpload()" class="back-button">← Indietro</button>
                    </div>
                </div>
            </div>`;
        results.style.display = 'block';
    }
}

function showOfflineWarning() {
    resultsContent.innerHTML = `
        <div class="error-message">
            <div class="error-title">Nessuna connessione</div>
            <div class="error-content">
                <strong>Sei offline.</strong> Lo storico è ancora consultabile, ma non si possono avviare nuove analisi.
                <div style="text-align: center; margin-top: 16px;">
                    <button onclick="backToUpload()" class="back-button">← Indietro</button>
                </div>
            </div>
        </div>`;
    results.style.display = 'block';
}

function formatMarkdown(text) {
    return text
        .replace(/RISPOSTE\s*\([^:]*\):[\s\S]*?(?=\*\*\d+\.|ANALISI|$)/gi, '')
        .replace(/ANALISI\s*\([^:]*\):/gi, '')
        .replace(/^([A-D]\).*?)\s*(?:\[CORRETTA\]|\(V\)|[✓✔])\s*$/gm, '<span style="color:#ffcc00;font-weight:600">$1</span>')
        .replace(/\*\*(\d+\..+?)\*\*/g, '<strong style="display:inline-block;margin-top:4px">$1</strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\s*---\s*\n/g, '<hr style="margin:10px 0;border:none;border-top:1px solid rgba(128,128,128,0.25)">')
        .replace(/\n{2,}/g, '\n')
        .replace(/\n/g, '<br>')
        .replace(/^(<br>)+/, '')
        .trim();
}

function displayResults(allResults, opts = {}) {
    const allQuestions = [];
    const allAnalyses = [];
    const flatAnswers = [];
    const rawAnalyses = [];

    allResults.forEach(result => {
        result.answers.forEach(a => {
            allQuestions.push({
                num: a.num,
                answer: a.letter,
                fonte: formatSource(a.source)
            });
            flatAnswers.push(a);
        });

        if (result.analysis) {
            rawAnalyses.push(result.analysis);
            allAnalyses.push(formatMarkdown(result.analysis));
        }
    });

    if (!opts.skipSave && flatAnswers.length > 0) {
        saveToHistory(flatAnswers, rawAnalyses.join('\n\n---\n\n'));
    }

    // Distribute available viewport across rows for an evenly-filled table
    const HEADER_H = 32;
    const BUTTON_H = 52;
    const available = Math.max(280, window.innerHeight - HEADER_H - BUTTON_H);
    const rowH = Math.max(28, Math.floor(available / Math.max(allQuestions.length, 1)));
    const fontSize = allQuestions.length > 15 ? '12px' : '13px';
    const numSize = allQuestions.length > 15 ? '10px' : '11px';
    const fonteSize = allQuestions.length > 15 ? '11px' : '12px';
    const headerSize = allQuestions.length > 15 ? '9px' : '10px';
    const pad = allQuestions.length > 15 ? '0px 3px' : '1px 4px';

    let html = '<div class="result-content">';
    if (opts.failedCount) {
        html += `<div style="background:rgba(255,204,0,0.12);border:1px solid rgba(255,204,0,0.35);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#ffcc00">
            ${opts.failedCount} immagine${opts.failedCount > 1 ? 'i' : ''} non analizzata${opts.failedCount > 1 ? 'e' : ''}, ${allResults.length} salvata${allResults.length > 1 ? 'e' : ''} nello storico
        </div>`;
    }
    html += `<table style="width: 100%; border-collapse: collapse; margin: 0; line-height: 1; table-layout: fixed;">`;
    html += '<colgroup><col style="width: 28px"><col style="width: 50%"><col></colgroup>';
    html += '<thead><tr>';
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${headerSize};">N°</th>`;
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${headerSize};">RISPOSTA</th>`;
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${headerSize};">FONTE</th>`;
    html += '</tr></thead><tbody>';

    allQuestions.forEach(q => {
        html += `<tr style="height: ${rowH}px;">`;
        html += `<td style="padding: ${pad}; text-align: center; border-bottom: 1px solid rgba(128,128,128,0.1); font-size: ${numSize}; line-height: 1;">${q.num}</td>`;
        html += `<td style="padding: 0 3px; text-align: center; border-bottom: 1px solid rgba(128,128,128,0.1); line-height: 1;"><span style="color: #ffcc00; font-weight: 900; font-size: ${allQuestions.length > 15 ? '17px' : '19px'}; letter-spacing: 0.08em;">${q.answer}</span></td>`;
        html += `<td style="padding: ${pad}; text-align: center; border-bottom: 1px solid rgba(128,128,128,0.1); font-size: ${fonteSize}; font-weight: 700; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${q.fonte}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table>';

    html += '<button onclick="backToUpload()" class="new-analysis-btn">';
    html += '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    html += '<span>Indietro</span>';
    html += '</button>';

    if (allAnalyses.length) {
        html += '<div style="margin-top: 14px;">';
        html += '<h3 style="font-size: 15px; margin-bottom: 8px;">Analisi:</h3>';
        html += '<div style="line-height: 1.5; opacity: 0.85; font-size: 13px;">';
        html += allAnalyses.join('\n\n');
        html += '</div></div>';
    }
    html += '</div>';

    resultsContent.innerHTML = html;
    results.style.display = 'block';
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.actions').style.display = 'none';
    const pt = document.getElementById('precisionToggle');
    if (pt) pt.style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    imgUploadArea.addEventListener('click', () => imgInput.click());
    imgUploadArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            imgInput.click();
        }
    });
    imgInput.addEventListener('change', handleImages);
    clearBtn.addEventListener('click', clearAll);
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    setupDragAndDrop(imgUploadArea, handleImagesDrop);
    updateHistoryButton();

    const precisionInput = document.getElementById('precisionInput');
    const precisionToggle = document.getElementById('precisionToggle');
    if (precisionInput) {
        precisionInput.checked = localStorage.getItem(PRECISION_KEY) === 'true';
        if (precisionInput.checked) precisionToggle.classList.add('active');
        precisionInput.addEventListener('change', () => {
            localStorage.setItem(PRECISION_KEY, precisionInput.checked);
            precisionToggle.classList.toggle('active', precisionInput.checked);
        });
    }

    setupOfflineBanner();
    setupUpdateBanner();
});

// --- Offline indicator ---
function setupOfflineBanner() {
    const banner = document.getElementById('offlineBanner');
    if (!banner) return;
    const update = () => { banner.hidden = navigator.onLine; };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
}

// --- Service worker update notification ---
function setupUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    const btn = document.getElementById('updateReloadBtn');
    if (!banner || !btn) return;
    btn.addEventListener('click', () => window.location.reload());
    let firstActivation = true;
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data?.type === 'SW_UPDATED') {
                if (firstActivation) { firstActivation = false; return; }
                banner.hidden = false;
            }
        });
    }
}

// PWA service worker registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => {
            console.warn('Service worker registration failed:', err);
        });
    });
}
