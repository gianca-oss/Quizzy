// server.js - Express server for Railway deployment
const express = require('express');
const cors = require('cors');
const path = require('path');
const { version } = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Injected by Railway at build time; absent when running locally.
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || null;
const shortCommit = COMMIT ? COMMIT.slice(0, 7) : null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Import the analyze handler
const analyzeHandler = require('./api/analyze-railway.js');

// API Routes
app.get('/api/analyze', analyzeHandler);
app.post('/api/analyze', analyzeHandler);

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    // Which build is answering: "ok" alone cannot tell a fresh container from
    // one still serving a commit that no longer exists, and uptime says
    // whether the process actually restarted.
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version,
        commit: shortCommit,
        uptimeSeconds: Math.round(process.uptime())
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}${shortCommit ? ` (commit ${shortCommit})` : ''}`);
});
