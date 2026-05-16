let images = [];

const HISTORY_KEY = 'quizzy_history';
const MAX_HISTORY = 50;

const imgUploadArea = document.getElementById('imgUploadArea');
const imgInput = document.getElementById('imgInput');
const imgLabel = document.getElementById('imgLabel');
const imgSublabel = document.getElementById('imgSublabel');
const imgStatus = document.getElementById('imgStatus');
const analyzeBtn = document.getElementById('analyzeBtn');
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

function showHistory() {
    const history = loadHistory();
    let html = '<div class="result-content" style="padding: 8px;">';
    html += '<h3 style="font-size: 16px; margin-bottom: 12px; text-align: center;">Storico Quiz</h3>';

    if (history.length === 0) {
        html += '<p style="text-align: center; opacity: 0.6; padding: 20px;">Nessun quiz salvato</p>';
    } else {
        html += '<div style="display: flex; flex-direction: column; gap: 8px;">';
        history.forEach(item => {
            html += `<div style="display: flex; align-items: center; gap: 8px; padding: 10px; background: rgba(128,128,128,0.08); border-radius: 8px;">`;
            html += `<div style="flex: 1; cursor: pointer;" onclick="openHistoryItem(${item.id})">`;
            html += `<div style="font-weight: 600; font-size: 14px;">${formatHistoryDate(item.date)}</div>`;
            html += `<div style="font-size: 12px; opacity: 0.7;">${item.questionsCount} domande</div>`;
            html += `</div>`;
            html += `<button onclick="shareHistoryItem(${item.id})" style="background: none; border: none; color: var(--text-primary); font-size: 18px; cursor: pointer; padding: 4px 8px;" title="Condividi">⤴</button>`;
            html += `<button onclick="deleteHistoryItem(${item.id})" style="background: none; border: none; color: #ff3b30; font-size: 18px; cursor: pointer; padding: 4px 8px;" title="Elimina">×</button>`;
            html += `</div>`;
        });
        html += '</div>';
    }

    html += '<div style="display: flex; gap: 8px; justify-content: center; margin-top: 16px;">';
    html += '<button onclick="backToUpload()" class="back-button">← Indietro</button>';
    if (history.length > 0) {
        html += '<button onclick="clearHistory()" class="back-button" style="color: #ff3b30;">Cancella tutto</button>';
    }
    html += '</div></div>';

    resultsContent.innerHTML = html;
    results.style.display = 'block';
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.actions').style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openHistoryItem(id) {
    const item = loadHistory().find(h => h.id === id);
    if (!item) return;
    displayResults([{ answers: item.answers, analysis: item.analysis }], { skipSave: true });
}

function buildReportHtml(item) {
    const dateLabel = formatHistoryDate(item.date);
    const sourceColors = { CITATO: '#34c759', VERIFICATO: '#007aff', AI: '#ff9500' };
    const sourceLabels = { CITATO: '📚 CITATO', VERIFICATO: '🔍 VERIFICATO', AI: '⚠️ AI' };

    let rows = '';
    item.answers.forEach(a => {
        const color = sourceColors[a.source] || sourceColors.AI;
        const label = sourceLabels[a.source] || sourceLabels.AI;
        rows += `<tr><td>${a.num}</td><td><strong>${a.letter}</strong></td><td style="color:${color}">${label}</td></tr>`;
    });

    const analysisHtml = (item.analysis || '')
        .replace(/^([A-D]\).*?)\s*\[CORRETTA\]\s*$/gm, '<span style="color:#34c759;font-weight:600">$1</span>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n{3,}/g, '\n\n')
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
            imgSublabel.textContent = 'Pronte per l\'analisi';
            imgStatus.textContent = '';
            analyzeBtn.style.background = '';
            analyzeBtn.style.borderColor = '';
        }
    } catch (err) {
        imgLabel.textContent = 'Errore';
        imgSublabel.textContent = err.message;
        images = [];
    }

    checkReady();
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
    analyzeBtn.style.background = '';
    analyzeBtn.style.borderColor = '';
    checkReady();
}

function checkReady() {
    analyzeBtn.disabled = !images.length;
}

function toggleAnalysis() {
    const section = document.getElementById('analysisSection');
    const btn = document.getElementById('toggleAnalysisBtn');
    if (section.style.display === 'none') {
        section.style.display = 'block';
        btn.textContent = 'Dettagli ▲';
    } else {
        section.style.display = 'none';
        btn.textContent = 'Dettagli ▼';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function backToUpload() {
    results.style.display = 'none';
    resultsContent.innerHTML = '';
    document.querySelector('.main-content').style.display = 'block';
    document.querySelector('.actions').style.display = 'flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

const SOURCE_STYLES = {
    CITATO: { indicator: '📚 CITATO', color: '#34c759' },
    VERIFICATO: { indicator: '🔍 VERIFICATO', color: '#007aff' },
    AI: { indicator: '⚠️ AI', color: '#ff9500' }
};

function formatSource(source) {
    const style = SOURCE_STYLES[source] || SOURCE_STYLES.AI;
    return `<span style="color: ${style.color}">${style.indicator}</span>`;
}

const PROGRESS_STEPS = [
    { text: 'Lettura immagine...', delay: 0 },
    { text: 'Estrazione domande...', delay: 2000 },
    { text: 'Ricerca nel materiale...', delay: 8000 },
    { text: 'Analisi con AI...', delay: 14000 },
    { text: 'Quasi fatto...', delay: 30000 }
];

function startProgressFeedback(imageIndex, totalImages) {
    const loadingText = document.querySelector('.loading-text');
    if (!loadingText) return null;

    const prefix = totalImages > 1 ? `[${imageIndex}/${totalImages}] ` : '';
    const timers = PROGRESS_STEPS.map(step =>
        setTimeout(() => { loadingText.textContent = prefix + step.text; }, step.delay)
    );

    return () => timers.forEach(clearTimeout);
}

async function analyze() {
    if (images.length === 0) return;

    loading.classList.add('show');
    results.style.display = 'none';
    resultsContent.innerHTML = '';

    try {
        const allResults = [];
        let questionStartNumber = 1;

        for (let i = 0; i < images.length; i++) {
            const stopProgress = startProgressFeedback(i + 1, images.length);

            const requestBody = {
                model: 'claude-3-haiku-20240307',
                max_tokens: 4000,
                startNumber: questionStartNumber,
                messages: [{
                    role: 'user',
                    content: [{
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/jpeg',
                            data: images[i]
                        }
                    }]
                }]
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000);

            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            stopProgress();

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();

            allResults.push({
                answers: data.answers || [],
                analysis: data.analysis || ''
            });

            questionStartNumber += data.metadata?.questionsAnalyzed || 0;
        }

        displayResults(allResults);

    } catch (err) {
        const message = err.name === 'AbortError' ? 'Timeout: server non risponde' : err.message;
        resultsContent.innerHTML = `
            <div class="error-message">
                <div class="error-title">Errore durante l'analisi</div>
                <div class="error-content">
                    <strong>${message}</strong>
                    <div class="error-note">
                        <strong>Suggerimenti:</strong><br>
                        1. Verifica la configurazione API su Railway<br>
                        2. Ricarica la pagina e riprova
                    </div>
                </div>
            </div>`;
        results.style.display = 'block';
    } finally {
        loading.classList.remove('show');
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) loadingText.textContent = 'Analisi in corso';
    }
}

function formatMarkdown(text) {
    return text
        .replace(/RISPOSTE\s*\([^:]*\):[\s\S]*?(?=\*\*\d+\.|ANALISI|$)/gi, '')
        .replace(/ANALISI\s*\([^:]*\):/gi, '')
        .replace(/^([A-D]\).*?)\s*\[CORRETTA\]\s*$/gm, '<span style="color:#34c759;font-weight:600">$1</span>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n{3,}/g, '\n\n')
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

    const rowH = Math.min(28, Math.floor(580 / Math.max(allQuestions.length, 1)));
    const fontSize = allQuestions.length > 15 ? '12px' : '13px';
    const numSize = allQuestions.length > 15 ? '10px' : '11px';
    const fonteSize = allQuestions.length > 15 ? '9px' : '10px';
    const pad = allQuestions.length > 15 ? '0px 3px' : '1px 4px';

    let html = '<div class="result-content">';
    html += `<table style="width: 100%; border-collapse: collapse; margin: 0; line-height: 1; table-layout: fixed;">`;
    html += '<colgroup><col style="width: 28px"><col style="width: 50%"><col></colgroup>';
    html += '<thead><tr>';
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${fonteSize};">N°</th>`;
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${fonteSize};">RISPOSTA</th>`;
    html += `<th style="padding: ${pad}; border-bottom: 1px solid rgba(128,128,128,0.3); font-size: ${fonteSize};">FONTE</th>`;
    html += '</tr></thead><tbody>';

    allQuestions.forEach(q => {
        html += `<tr style="height: ${rowH}px;">`;
        html += `<td style="padding: ${pad}; text-align: center; border-bottom: 1px solid rgba(128,128,128,0.1); font-size: ${numSize}; line-height: 1;">${q.num}</td>`;
        html += `<td style="padding: ${pad}; text-align: center; font-weight: bold; font-size: ${fontSize}; border-bottom: 1px solid rgba(128,128,128,0.1); line-height: 1;">${q.answer}</td>`;
        html += `<td style="padding: ${pad}; text-align: center; border-bottom: 1px solid rgba(128,128,128,0.1); font-size: ${fonteSize}; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${q.fonte}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table>';

    html += '<div style="display: flex; gap: 8px; justify-content: center; margin-top: 10px;">';
    html += '<button onclick="backToUpload()" class="back-button">← Nuova</button>';
    html += '<button onclick="toggleAnalysis()" class="back-button" id="toggleAnalysisBtn">Dettagli ▼</button>';
    html += '</div>';

    html += '<div id="analysisSection" style="display: none; margin-top: 12px;">';
    html += '<h3 style="font-size: 15px; margin-bottom: 8px;">Analisi:</h3>';
    html += '<div style="white-space: pre-wrap; line-height: 1.5; opacity: 0.85; font-size: 13px;">';
    html += allAnalyses.join('\n\n');
    html += '</div></div></div>';

    resultsContent.innerHTML = html;
    results.style.display = 'block';
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.actions').style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    analyzeBtn.style.background = '#34c759';
    analyzeBtn.style.borderColor = '#34c759';
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
    analyzeBtn.addEventListener('click', analyze);
    clearBtn.addEventListener('click', clearAll);
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    setupDragAndDrop(imgUploadArea, handleImagesDrop);
    updateHistoryButton();
});
