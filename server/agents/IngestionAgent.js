import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const IGNORED_DIRS = new Set([
    '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
    '.idea', '.vscode', '.settings', 'dist', 'build', '.next',
    'target', '.gradle', '.mvn', 'vendor', 'bower_components',
    '.DS_Store', 'coverage', '.nyc_output', '.pytest_cache',
]);

const IGNORED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
    '.mp4', '.mp3', '.wav', '.avi', '.mov', '.mkv',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt',
    '.exe', '.dll', '.so', '.dylib', '.o', '.class', '.jar',
    '.pyc', '.pyo', '.whl',
    '.lock', '.log',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

const LANGUAGE_MAP = {
    '.py': 'python',
    '.sql': 'sql',
    '.scala': 'scala',
    '.java': 'java',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.r': 'r',
    '.R': 'r',
    '.sh': 'shell',
    '.bash': 'shell',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.json': 'json',
    '.xml': 'xml',
    '.toml': 'toml',
    '.ini': 'ini',
    '.cfg': 'config',
    '.conf': 'config',
    '.md': 'markdown',
    '.txt': 'text',
    '.csv': 'csv',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.lua': 'lua',
    '.pl': 'perl',
    '.pm': 'perl',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hs': 'haskell',
    '.jl': 'julia',
    '.m': 'matlab',
    '.dart': 'dart',
    '.groovy': 'groovy',
    '.tf': 'terraform',
    '.hcl': 'hcl',
};

const MAX_FILE_SIZE = 500 * 1024; // 500KB per file

export class IngestionAgent {
    constructor() {
        this.name = 'IngestionAgent';
    }

    async execute(sharedState, input) {
        sharedState.updateStatus('processing', 'Ingesting repository...', 5);
        let tempDir;

        try {
            if (input.githubUrl) {
                tempDir = await this.cloneRepo(input.githubUrl);
            } else if (input.zipPath) {
                tempDir = await this.extractZip(input.zipPath);
            } else {
                throw new Error('No input provided. Supply a GitHub URL or ZIP file.');
            }

            const files = [];
            const languagesDetected = new Set();
            const projectStructure = {};

            await this.walkDirectory(tempDir, tempDir, files, languagesDetected, projectStructure);

            sharedState.mergeRepoIndex({
                files,
                languages_detected: Array.from(languagesDetected),
                project_structure: projectStructure,
                tempDir,
            });

            sharedState.updateStatus('processing', 'Repository ingested successfully', 10);
            return { success: true, fileCount: files.length, languages: Array.from(languagesDetected) };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    async cloneRepo(url) {
        const tempDir = path.join(os.tmpdir(), `repolens_${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });

        // Sanitize URL
        const cleanUrl = url.trim().replace(/\.git$/, '') + '.git';
        try {
            await execAsync(`git clone --depth 1 "${cleanUrl}" "${tempDir}"`, {
                timeout: 120000,
            });
        } catch (error) {
            throw new Error(`Failed to clone repository: ${error.message}`);
        }
        return tempDir;
    }

    async extractZip(zipPath) {
        const AdmZip = (await import('adm-zip')).default;
        const tempDir = path.join(os.tmpdir(), `repolens_${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(tempDir, true);

        // Check if ZIP contains a single root folder
        const entries = await fs.readdir(tempDir);
        if (entries.length === 1) {
            const singleEntry = path.join(tempDir, entries[0]);
            const stat = await fs.stat(singleEntry);
            if (stat.isDirectory()) {
                return singleEntry;
            }
        }
        return tempDir;
    }

    async walkDirectory(baseDir, currentDir, files, languages, structure) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(baseDir, fullPath);

            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                structure[relativePath] = { type: 'directory', children: [] };
                await this.walkDirectory(baseDir, fullPath, files, languages, structure);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (IGNORED_EXTENSIONS.has(ext)) continue;

                const stat = await fs.stat(fullPath);
                if (stat.size > MAX_FILE_SIZE) continue;
                if (stat.size === 0) continue;

                const language = LANGUAGE_MAP[ext] || 'unknown';
                if (language !== 'unknown') {
                    languages.add(language);
                }

                files.push({
                    path: relativePath,
                    absolutePath: fullPath,
                    language,
                    size: stat.size,
                    extension: ext,
                });

                // Add to parent directory structure
                const parentDir = path.dirname(relativePath);
                if (structure[parentDir]) {
                    structure[parentDir].children.push(entry.name);
                }
            }
        }
    }
}
