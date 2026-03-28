import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { Pipeline } from './agents/Pipeline.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Multer for ZIP uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), 'repolens_uploads');
        fs.mkdir(uploadDir, { recursive: true }).then(() => cb(null, uploadDir));
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}_${file.originalname}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only ZIP files are allowed'));
        }
    },
});

// In-memory job store
const jobs = new Map();
const pipeline = new Pipeline();

// --- API Routes ---

// POST /api/analyze — start analysis
app.post('/api/analyze', upload.single('zipFile'), async (req, res) => {
    try {
        const jobId = uuidv4();
        const input = {};

        if (req.file) {
            input.zipPath = req.file.path;
        } else if (req.body.githubUrl) {
            const url = req.body.githubUrl.trim();
            if (!url.match(/^https?:\/\/(www\.)?github\.com\/.+\/.+/)) {
                return res.status(400).json({ error: 'Invalid GitHub URL' });
            }
            input.githubUrl = url;
        } else {
            return res.status(400).json({ error: 'Please provide a GitHub URL or upload a ZIP file' });
        }

        // Initialize job
        jobs.set(jobId, {
            id: jobId,
            status: 'processing',
            progress: 0,
            currentStep: 'Starting analysis...',
            startedAt: new Date().toISOString(),
            result: null,
            errors: [],
        });

        res.json({ jobId, status: 'processing', message: 'Analysis started' });

        // Run pipeline in background
        pipeline
            .run(jobId, input)
            .then((state) => {
                const job = jobs.get(jobId);
                if (job) {
                    job.status = state.status;
                    job.progress = state.progress;
                    job.currentStep = state.currentStep;
                    job.result = state.final_output;
                    job.errors = state.errors;
                    job.completedAt = new Date().toISOString();
                }
            })
            .catch((error) => {
                const job = jobs.get(jobId);
                if (job) {
                    job.status = 'failed';
                    job.currentStep = `Error: ${error.message}`;
                    job.errors.push({ message: error.message });
                    job.completedAt = new Date().toISOString();
                }
            });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/status/:jobId
app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
        id: job.id,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        startedAt: job.startedAt,
        errors: job.errors,
    });
});

// GET /api/results/:jobId
app.get('/api/results/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status === 'processing') {
        return res.json({
            status: 'processing',
            progress: job.progress,
            currentStep: job.currentStep,
        });
    }
    res.json({
        status: job.status,
        result: job.result,
        errors: job.errors,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
    console.log(`🔍 RepoLens AI server running on http://localhost:${PORT}`);
});
