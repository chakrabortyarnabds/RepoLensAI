import fs from 'fs/promises';
import { callGemini, extractJSON } from '../../utils/gemini.js';

export class GenericParser {
    constructor() {
        this.name = 'GenericParser';
    }

    async parseFile(filePath, relativePath) {
        const content = await fs.readFile(filePath, 'utf-8');

        // First try heuristic parsing
        const heuristicResult = this.heuristicParse(content, relativePath);

        // If heuristic finds interesting things, or file is small enough for LLM
        if (content.length <= 15000) {
            try {
                const llmResult = await this.llmParse(content, relativePath);
                if (llmResult) {
                    return this.mergeResults(heuristicResult, llmResult);
                }
            } catch (error) {
                console.warn(`[GenericParser] LLM parse failed for ${relativePath}:`, error.message);
            }
        }

        return heuristicResult;
    }

    heuristicParse(content, relativePath) {
        const lines = content.split('\n');
        const result = {
            file: relativePath,
            language: 'unknown',
            inputs: [],
            outputs: [],
            transformations: [],
            intermediate_steps: [],
            dependencies: [],
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const lineNum = i + 1;

            // Detect file I/O patterns (generic)
            const readPatterns = [
                /(?:read|load|open|input|fetch|get|import|ingest)\s*[\(\.]\s*['"](.*?)['"]/i,
                /(?:source|from|input)\s*[:=]\s*['"](.*?)['"]/i,
            ];
            for (const pattern of readPatterns) {
                const match = line.match(pattern);
                if (match) {
                    result.inputs.push({
                        type: 'file_read',
                        source: match[1],
                        line: lineNum,
                    });
                }
            }

            // Detect write patterns
            const writePatterns = [
                /(?:write|save|output|export|store|dump)\s*[\(\.]\s*['"](.*?)['"]/i,
                /(?:target|output|destination|sink)\s*[:=]\s*['"](.*?)['"]/i,
            ];
            for (const pattern of writePatterns) {
                const match = line.match(pattern);
                if (match) {
                    result.outputs.push({
                        type: 'file_write',
                        target: match[1],
                        line: lineNum,
                    });
                }
            }

            // Detect transformation keywords
            const transformKeywords = [
                { pattern: /(?:transform|convert|process|calculate|compute)/i, type: 'transformation' },
                { pattern: /(?:filter|where|select|exclude)/i, type: 'filter' },
                { pattern: /(?:sort|order|rank)/i, type: 'sort' },
                { pattern: /(?:group|aggregate|summarize|reduce)/i, type: 'aggregation' },
                { pattern: /(?:merge|join|combine|concat|union)/i, type: 'merge' },
                { pattern: /(?:map|foreach|iterate|loop)/i, type: 'iteration' },
            ];
            for (const kw of transformKeywords) {
                if (kw.pattern.test(line) && line.includes('(')) {
                    result.transformations.push({
                        type: kw.type,
                        description: line.substring(0, 100),
                        line: lineNum,
                    });
                    break;
                }
            }

            // Detect imports/requires
            const importPatterns = [
                /(?:import|require|include|use|using|include)\s+['"<]?([\w./\\-]+)/,
            ];
            for (const pattern of importPatterns) {
                const match = line.match(pattern);
                if (match) {
                    result.dependencies.push(match[1]);
                }
            }
        }

        // Deduplicate dependencies
        result.dependencies = [...new Set(result.dependencies)];

        return result;
    }

    async llmParse(content, relativePath) {
        const prompt = `Analyze this source code file and extract data pipeline information.

File: ${relativePath}

\`\`\`
${content.substring(0, 12000)}
\`\`\`

Return ONLY a JSON object with this exact structure:
{
  "inputs": [{"type": "string", "source": "string", "description": "string"}],
  "outputs": [{"type": "string", "target": "string", "description": "string"}],
  "transformations": [{"type": "string", "description": "plain English description"}],
  "intermediate_steps": [{"type": "string", "description": "string"}],
  "dependencies": ["string"]
}

Rules:
- inputs: data sources read by this code (files, databases, APIs)
- outputs: data destinations written by this code
- transformations: data processing operations (describe in plain English)
- intermediate_steps: temporary data processing stages
- dependencies: external libraries or modules used
- If the file is not a data pipeline, return empty arrays
- Be precise and grounded in the actual code`;

        const response = await callGemini(prompt);
        return extractJSON(response);
    }

    mergeResults(heuristic, llm) {
        if (!llm) return heuristic;

        return {
            file: heuristic.file,
            language: heuristic.language,
            inputs: [...heuristic.inputs, ...(llm.inputs || [])],
            outputs: [...heuristic.outputs, ...(llm.outputs || [])],
            transformations: [...heuristic.transformations, ...(llm.transformations || [])],
            intermediate_steps: [...heuristic.intermediate_steps, ...(llm.intermediate_steps || [])],
            dependencies: [...new Set([...heuristic.dependencies, ...(llm.dependencies || [])])],
        };
    }
}
