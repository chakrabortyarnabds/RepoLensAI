import { SharedState } from './SharedState.js';
import { IngestionAgent } from './IngestionAgent.js';
import { PlannerAgent } from './PlannerAgent.js';
import { LLMExtractorAgent } from './LLMExtractorAgent.js';
import { PythonParser } from './parsers/PythonParser.js';
import { SQLParser } from './parsers/SQLParser.js';
import { GenericParser } from './parsers/GenericParser.js';
import { LineageAgent } from './LineageAgent.js';
import { MetadataAgent } from './MetadataAgent.js';
import { ExplainerAgent } from './ExplainerAgent.js';
import { ValidatorAgent } from './ValidatorAgent.js';
import { UIFormatterAgent } from './UIFormatterAgent.js';

export class Pipeline {
    constructor() {
        this.ingestionAgent = new IngestionAgent();
        this.plannerAgent = new PlannerAgent();
        this.llmExtractorAgent = new LLMExtractorAgent();
        this.lineageAgent = new LineageAgent();
        this.metadataAgent = new MetadataAgent();
        this.explainerAgent = new ExplainerAgent();
        this.validatorAgent = new ValidatorAgent();
        this.uiFormatterAgent = new UIFormatterAgent();

        // Deterministic parsers as fallback
        this.parsers = {
            python: new PythonParser(),
            sql: new SQLParser(),
            generic: new GenericParser(),
        };
    }

    async run(jobId, input) {
        const state = new SharedState(jobId);

        try {
            // Step 1: Ingest repository
            console.log(`[Pipeline] Job ${jobId}: Ingesting repository...`);
            await this.ingestionAgent.execute(state, input);

            if (state.repo_index.files.length === 0) {
                state.updateStatus('completed', 'No analyzable files found', 100);
                state.final_output = {
                    summary: 'No analyzable code files were found in this repository.',
                    steps: [],
                    lineage: { nodes: [], edges: [] },
                    transformations: [],
                    metadata: { datasets: [], schemas: [], attributes: {} },
                    validation: { valid: true, issues: [] },
                    stats: { total_files: 0, languages: [], analyzed_at: new Date().toISOString() },
                };
                return state;
            }

            // Step 2: Create execution plan
            console.log(`[Pipeline] Job ${jobId}: Planning execution...`);
            await this.plannerAgent.execute(state);

            // Step 3: LLM Extraction (Primary — Semantic parsing)
            console.log(`[Pipeline] Job ${jobId}: Deep Extracting context via LLM...`);
            await this.llmExtractorAgent.execute(state);

            // Step 3b: Fallback — if LLM produced no data, use deterministic parsers
            const llmData = state.llm_extracted_data;
            const llmProducedData = llmData && llmData.datasets && llmData.datasets.length > 0;

            if (!llmProducedData) {
                console.log(`[Pipeline] Job ${jobId}: LLM extraction empty. Falling back to deterministic parsers...`);
                state.updateStatus('processing', 'Using fallback parsers...', 30);

                const DEDICATED_PARSERS = ['python', 'sql'];
                const parsePromises = [];

                for (const file of state.repo_index.files) {
                    const lang = file.language;
                    if (['markdown', 'text', 'json', 'yaml', 'toml', 'ini', 'config', 'csv', 'xml', 'log', 'lock'].includes(lang)) {
                        continue;
                    }
                    const parser = DEDICATED_PARSERS.includes(lang) ? this.parsers[lang] : this.parsers.generic;
                    parsePromises.push(
                        parser.parseFile(file.absolutePath, file.path)
                            .then((result) => {
                                if (result) state.mergeParsedOutput(result);
                            })
                            .catch((error) => {
                                console.warn(`[Pipeline] Parse error for ${file.path}:`, error.message);
                            })
                    );
                }

                const BATCH_SIZE = 10;
                for (let i = 0; i < parsePromises.length; i += BATCH_SIZE) {
                    await Promise.all(parsePromises.slice(i, i + BATCH_SIZE));
                    const progress = 30 + Math.floor((i / parsePromises.length) * 15);
                    state.updateStatus('processing', `Parsed ${Math.min(i + BATCH_SIZE, parsePromises.length)}/${parsePromises.length} files...`, progress);
                }
            }

            // Step 4: Build lineage
            console.log(`[Pipeline] Job ${jobId}: Building lineage...`);
            await this.lineageAgent.execute(state);

            // Step 5: Extract metadata
            console.log(`[Pipeline] Job ${jobId}: Extracting metadata...`);
            await this.metadataAgent.execute(state);

            // Step 6: Generate documentation
            console.log(`[Pipeline] Job ${jobId}: Generating documentation...`);
            await this.explainerAgent.execute(state);

            // Step 7: Validate
            console.log(`[Pipeline] Job ${jobId}: Validating...`);
            await this.validatorAgent.execute(state);

            // Step 8: Format for UI
            console.log(`[Pipeline] Job ${jobId}: Formatting output...`);
            await this.uiFormatterAgent.execute(state);

            console.log(`[Pipeline] Job ${jobId}: Complete!`);
            return state;
        } catch (error) {
            console.error(`[Pipeline] Job ${jobId} failed:`, error);
            state.addError('Pipeline', error);
            state.updateStatus('failed', `Error: ${error.message}`, state.progress);
            return state;
        }
    }
}
