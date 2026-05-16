let images = [];

const imgUploadArea = document.getElementById('imgUploadArea');
const imgInput = document.getElementById('imgInput');
const imgLabel = document.getElementById('imgLabel');
const imgSublabel = document.getElementById('imgSublabel');
const imgStatus = document.getElementById('imgStatus');
const analyzeBtn = document.getElementById('analyzeBtn');
const clearBtn = document.getElementById('clearBtn');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsContent = document.getElementById('resultsContent');

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

function parseQuizContent(htmlContent) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlContent;

    const questions = [];
    tempDiv.querySelectorAll('table').forEach(table => {
        table.querySelectorAll('tr').forEach((row, index) => {
            if (index === 0) return;
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                questions.push({
                    num: cells[0].textContent.trim(),
                    answer: cells[1].textContent.trim(),
                    row: row.cloneNode(true)
                });
            }
        });
    });

    return { questions };
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
            const resultText = data.content?.[0]?.text || '';

            allResults.push({
                content: resultText,
                parsed: parseQuizContent(resultText)
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

function displayResults(allResults) {
    let globalQuestionNum = 0;
    const allQuestions = [];
    const allAnalyses = [];

    allResults.forEach(result => {
        result.parsed.questions.forEach(q => {
            globalQuestionNum++;
            allQuestions.push({
                num: globalQuestionNum,
                answer: q.answer,
                fonte: q.row.cells[2] ? q.row.cells[2].innerHTML : '⚠️ AI'
            });
        });

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = result.content;
        const analysisHeader = tempDiv.querySelector('h3');
        if (analysisHeader?.textContent.includes('Analisi')) {
            const analysisDiv = analysisHeader.nextElementSibling;
            if (analysisDiv) {
                let analysisText = analysisDiv.innerHTML;
                const baseNum = globalQuestionNum - result.parsed.questions.length;
                result.parsed.questions.forEach((q, idx) => {
                    analysisText = analysisText.replace(
                        new RegExp(`\\*\\*${idx + 1}\\.`, 'g'),
                        `**${baseNum + idx + 1}.`
                    );
                });
                allAnalyses.push(analysisText);
            }
        }
    });

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
    setupDragAndDrop(imgUploadArea, handleImagesDrop);
});
