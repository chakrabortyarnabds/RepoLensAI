import fs from 'fs/promises';
import { callGemini, extractJSON } from '../utils/gemini.js';

export class LLMExtractorAgent {
    constructor() {
        this.name = 'LLMExtractorAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Extracting lineage using LLM...', 25);

        try {
            const codeFiles = sharedState.repo_index.files.filter(f => 
                !['markdown', 'text', 'json', 'yaml', 'toml', 'ini', 'config', 'csv', 'xml', 'log'].includes(f.language)
            );

            // Group files into chunks to not blow up context window
            const chunks = await this.chunkFiles(codeFiles, 25000); // characters per chunk
            let totalProcessed = 0;

            const allDatasets = new Map();
            const allLineage = [];

            for (const chunk of chunks) {
                totalProcessed += chunk.length;
                sharedState.updateStatus('processing', `Extracting logic from chunk (${totalProcessed}/${codeFiles.length} files)...`, 25 + Math.floor((totalProcessed / codeFiles.length) * 20));

                const prompt = this.buildPrompt(chunk);
                let retries = 2;
                let parsedJSON = null;

                while (retries > 0) {
                    try {
                        console.log(`[LLMExtractor] Sending prompt to Gemini...`);
                        const response = await callGemini(prompt);
                        console.log(`[LLMExtractor] Gemini raw response length: ${response?.length}`);
                        parsedJSON = extractJSON(response);
                        console.log(`[LLMExtractor] Parsed JSON datasets count: ${parsedJSON?.datasets?.length || 0}`);
                        if (parsedJSON && parsedJSON.column_lineage) break;
                    } catch (err) {
                        parsedJSON = null;
                        console.warn(`[LLMExtractor] Parse failed, trying again... Error:`, err.message);
                    }
                    retries--;
                }

                if (parsedJSON) {
                    // Merge into global map to handle duplicates across chunks
                    for (const ds of (parsedJSON.datasets || [])) {
                        const existing = allDatasets.get(ds.name) || { name: ds.name, columns: [], type: 'intermediate' };
                        existing.type = ds.type === 'input' || ds.type === 'output' ? ds.type : existing.type;
                        if (ds.zone) existing.zone = ds.zone;
                        if (ds.format) existing.format = ds.format;
                        
                        // Merge columns
                        for (const col of (ds.columns || [])) {
                            if (!existing.columns.find(c => c.name === col.name)) {
                                existing.columns.push(col);
                            }
                        }
                        allDatasets.set(ds.name, existing);
                    }

                    for (const lin of (parsedJSON.column_lineage || [])) {
                        allLineage.push(lin);
                    }
                }
            }

            // Save results to shared state in a structure LineageAgent will expect
            sharedState.llm_extracted_data = {
                datasets: Array.from(allDatasets.values()),
                column_lineage: allLineage
            };

            sharedState.updateStatus('processing', 'Lineage extraction complete', 45);
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    async chunkFiles(files, maxChars) {
        const chunks = [];
        let currentChunk = [];
        let currentCharCount = 0;

        for (const file of files) {
            const content = await fs.readFile(file.absolutePath, 'utf-8');
            // Basic cleaning to save tokens
            const cleanedContent = content
                .split('\n')
                .filter(line => line.trim().length > 0 && !line.trim().startsWith('#'))
                .join('\n');

            if (currentCharCount + cleanedContent.length > maxChars && currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentCharCount = 0;
            }

            currentChunk.push({
                path: file.path,
                content: cleanedContent
            });
            currentCharCount += cleanedContent.length;
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk);
        }

        return chunks;
    }

    buildPrompt(chunkFiles) {
        let codeContext = '';
        for (const f of chunkFiles) {
            codeContext += `=== FILE: ${f.path} ===\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
        }

        return `Analyze the following ETL/Data Engineering codebase chunk and extract the data lineage at BOTH the dataset and column level using a Semantic Understanding approach.
Do not rely on rigid parsing rules. Connect logic across the given files.

${codeContext}

REQUIRED OUTPUT FORMAT
Return a strictly valid JSON object exactly matching this schema:
{
  "datasets": [
    {
      "name": "exact_table_or_dataset_name",
      "type": "input", // MUST BE one of: "input", "output", "intermediate"
      "zone": "landing zone", // e.g. "working zone", "warehouse", etc.
      "format": "csv", // e.g. "parquet", "redshift", "delta"
      "columns": [
        { "name": "col1", "dataType": "string" }
      ]
    }
  ],
  "column_lineage": [
    {
      "output_column": "adjusted_amount",
      "source_columns": ["amount", "tax"],
      "transformation": "amount + tax * 1.1", // EXPLICIT logic, do NOT write "data is transformed". Write specific formula or SQL.
      "source_dataset": "transactions",
      "target_dataset": "enriched_transactions",
      "confidence": "high" // MUST BE one of: "high", "medium", "low". Base this on explicit code vs loose inference.
    }
  ]
}

CRITICAL RULES:
1. Every dataset MUST explicitly list all identifiable columns. Even if not strictly defined in a schema, infer them from Select statements, dataframes, or mapping.
2. Every output column inside "column_lineage" MUST have a transformation. Do NOT say "processed". Say what actually happened to the column. If it's a direct copy, say "direct mapping".
3. Track the flows intelligently. Link the \`source_dataset\` and \`target_dataset\` exactly to the datasets defined.
4. If a piece of data is loaded from S3/Files and later pushed to Warehouse, track that step-by-step logic.
5. If confidence is low due to dynamic mapping, still output the best-effort lineage but set confidence to "low".`;
    }
}
