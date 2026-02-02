// preprocess-embeddings.js - Genera embeddings OpenAI per ricerca semantica
// Esegui: node preprocess-embeddings.js

const fs = require('fs').promises;
const path = require('path');

const PROCESSED_DIR = './data/processed/strategia-internazionalizzazione';
const OUTPUT_FILE = './data/processed/strategia-internazionalizzazione/embeddings.json';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Batch size per API OpenAI (max 2048 input per batch)
const BATCH_SIZE = 50;

/**
 * Chiama OpenAI Embeddings API
 */
async function getEmbeddings(texts) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: texts,
            dimensions: 512 // Ridotto per efficienza (default 1536)
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.data.map(item => item.embedding);
}

/**
 * Carica tutti i chunks dai file JSON
 */
async function loadAllChunks() {
    const files = await fs.readdir(PROCESSED_DIR);
    const chunkFiles = files.filter(f => f.startsWith('chunks_') && f.endsWith('.json'));

    let allChunks = [];

    for (const file of chunkFiles.sort()) {
        const content = await fs.readFile(path.join(PROCESSED_DIR, file), 'utf-8');
        const chunks = JSON.parse(content);
        allChunks = allChunks.concat(chunks);
    }

    return allChunks;
}

/**
 * Processa chunks in batch
 */
async function processInBatches(chunks) {
    const results = [];
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    console.log(`\n📦 Processando ${chunks.length} chunks in ${totalBatches} batch...\n`);

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const batch = chunks.slice(i, i + BATCH_SIZE);

        // Prepara testi per embedding (usa solo i primi 8000 caratteri per chunk)
        const texts = batch.map(chunk => {
            const text = chunk.text.substring(0, 8000);
            return text;
        });

        console.log(`  🔄 Batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);

        try {
            const embeddings = await getEmbeddings(texts);

            // Associa embeddings ai chunks
            batch.forEach((chunk, idx) => {
                results.push({
                    id: chunk.id,
                    page: chunk.page,
                    pages: chunk.pages,
                    text: chunk.text,
                    keywords: chunk.keywords,
                    embedding: embeddings[idx]
                });
            });

            console.log(`  ✅ Batch ${batchNum} completato`);

            // Rate limiting: attendi 200ms tra i batch
            if (i + BATCH_SIZE < chunks.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }

        } catch (error) {
            console.error(`  ❌ Errore batch ${batchNum}:`, error.message);

            // Riprova singolarmente in caso di errore
            console.log(`  🔄 Riprovo singolarmente...`);
            for (const chunk of batch) {
                try {
                    const [embedding] = await getEmbeddings([chunk.text.substring(0, 8000)]);
                    results.push({
                        id: chunk.id,
                        page: chunk.page,
                        pages: chunk.pages,
                        text: chunk.text,
                        keywords: chunk.keywords,
                        embedding: embedding
                    });
                } catch (err) {
                    console.error(`    ❌ Fallito chunk ${chunk.id}:`, err.message);
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    return results;
}

/**
 * Main
 */
async function main() {
    console.log('🚀 GENERAZIONE EMBEDDINGS OPENAI');
    console.log('================================\n');

    // Verifica API key
    if (!OPENAI_API_KEY) {
        console.error('❌ OPENAI_API_KEY non configurata!');
        console.error('   Esegui: export OPENAI_API_KEY="sk-..."');
        process.exit(1);
    }
    console.log('✅ API Key configurata');

    // Carica chunks
    console.log('\n📖 Caricamento chunks...');
    const chunks = await loadAllChunks();
    console.log(`✅ Caricati ${chunks.length} chunks`);

    // Genera embeddings
    const startTime = Date.now();
    const chunksWithEmbeddings = await processInBatches(chunks);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n⏱️  Tempo totale: ${elapsed}s`);

    // Salva risultato
    console.log('\n💾 Salvataggio embeddings...');

    const output = {
        version: '1.0-semantic',
        model: 'text-embedding-3-small',
        dimensions: 512,
        generatedAt: new Date().toISOString(),
        stats: {
            totalChunks: chunksWithEmbeddings.length,
            embeddingSize: 512,
            processingTimeSeconds: parseFloat(elapsed)
        },
        chunks: chunksWithEmbeddings
    };

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(output));

    const stats = await fs.stat(OUTPUT_FILE);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    console.log(`✅ Salvato: ${OUTPUT_FILE} (${sizeMB} MB)`);

    // Report finale
    console.log('\n' + '='.repeat(50));
    console.log('✅ EMBEDDINGS GENERATI CON SUCCESSO!');
    console.log('='.repeat(50));
    console.log(`\n📊 Riepilogo:`);
    console.log(`   📦 Chunks processati: ${chunksWithEmbeddings.length}`);
    console.log(`   📐 Dimensioni embedding: 512`);
    console.log(`   💾 File output: ${OUTPUT_FILE}`);
    console.log(`   📁 Dimensione file: ${sizeMB} MB`);
    console.log(`   ⏱️  Tempo elaborazione: ${elapsed}s`);

    // Stima costi
    const totalTokens = chunks.reduce((sum, c) => sum + Math.ceil(c.text.length / 4), 0);
    const costEstimate = (totalTokens / 1000000 * 0.02).toFixed(4);
    console.log(`\n💰 Costo stimato: ~$${costEstimate} (${totalTokens.toLocaleString()} tokens)`);
}

main().catch(console.error);
