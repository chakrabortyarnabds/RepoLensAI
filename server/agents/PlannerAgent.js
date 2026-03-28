export class PlannerAgent {
    constructor() {
        this.name = 'PlannerAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Creating execution plan...', 15);

        try {
            const { files, languages_detected } = sharedState.repo_index;

            // Group files by language
            const filesByLanguage = {};
            for (const file of files) {
                if (!filesByLanguage[file.language]) {
                    filesByLanguage[file.language] = [];
                }
                filesByLanguage[file.language].push(file);
            }

            // Parser assignments
            const DEDICATED_PARSERS = ['python', 'sql'];
            const parserAssignments = {};
            const taskGraph = [];

            for (const [language, langFiles] of Object.entries(filesByLanguage)) {
                // Skip non-code and non-relevant files
                if (['markdown', 'text', 'json', 'yaml', 'toml', 'ini', 'config', 'csv', 'xml', 'log', 'lock'].includes(language)) {
                    continue;
                }
                
                // Add all code files to LLM extraction task
                parserAssignments[language] = {
                    parser: 'llm_extractor',
                    files: langFiles.map((f) => f.path),
                    fileCount: langFiles.length,
                };
            }

            taskGraph.push({
                id: 'extract_lineage',
                type: 'llm_extract',
                dependencies: [],
                status: 'pending',
            });

            // Add post-processing tasks
            taskGraph.push({
                id: 'build_lineage',
                type: 'lineage',
                dependencies: ['extract_lineage'],
                status: 'pending',
            });

            taskGraph.push({
                id: 'extract_metadata',
                type: 'metadata',
                dependencies: ['extract_lineage'],
                status: 'pending',
            });

            taskGraph.push({
                id: 'generate_explanation',
                type: 'explain',
                dependencies: ['build_lineage', 'extract_metadata'],
                status: 'pending',
            });

            taskGraph.push({
                id: 'validate',
                type: 'validate',
                dependencies: ['generate_explanation'],
                status: 'pending',
            });

            taskGraph.push({
                id: 'format_output',
                type: 'format',
                dependencies: ['validate'],
                status: 'pending',
            });

            sharedState.execution_plan = {
                task_graph: taskGraph,
                parser_assignments: parserAssignments,
                total_files: files.length,
                code_files: Object.values(parserAssignments).reduce((s, p) => s + p.fileCount, 0),
                languages: languages_detected,
            };

            sharedState.updateStatus('processing', 'Execution plan ready', 18);
            return {
                success: true,
                parsers: Object.keys(parserAssignments),
                tasks: taskGraph.length,
            };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }
}
