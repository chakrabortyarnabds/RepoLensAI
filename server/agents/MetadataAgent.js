export class MetadataAgent {
    constructor() {
        this.name = 'MetadataAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Extracting metadata...', 60);

        try {
            const datasets = [];
            const schemas = {};
            const attributes = {
                total_files: sharedState.repo_index.files.length,
                languages: sharedState.repo_index.languages_detected,
                total_transformations: 0,
                total_inputs: 0,
                total_outputs: 0,
                execution_pattern: 'batch', // default
                frameworks_detected: new Set(),
            };

            const datasetNames = new Set();

            for (const parsed of sharedState.parsed_outputs) {
                // Collect datasets from inputs
                for (const input of (parsed.inputs || [])) {
                    const name = input.source || input.type;
                    if (name && !datasetNames.has(name)) {
                        datasetNames.add(name);
                        datasets.push({
                            name,
                            type: 'input',
                            format: this.inferFormat(name, input),
                            source_file: parsed.file,
                            framework: input.framework || 'unknown',
                        });
                    }
                    if (input.framework) attributes.frameworks_detected.add(input.framework);
                    attributes.total_inputs++;
                }

                // Collect datasets from outputs
                for (const output of (parsed.outputs || [])) {
                    const name = output.target || output.type;
                    if (name && !datasetNames.has(name)) {
                        datasetNames.add(name);
                        datasets.push({
                            name,
                            type: 'output',
                            format: this.inferFormat(name, output),
                            source_file: parsed.file,
                            framework: output.framework || 'unknown',
                        });
                    }
                    if (output.framework) attributes.frameworks_detected.add(output.framework);
                    attributes.total_outputs++;
                }

                // Extract schema information from intermediate steps
                for (const step of (parsed.intermediate_steps || [])) {
                    if (step.type === 'schema_definition' && step.columns) {
                        schemas[step.table] = {
                            columns: step.columns,
                            source_file: parsed.file,
                        };
                    }
                }

                attributes.total_transformations += (parsed.transformations || []).length;
            }

            // Detect streaming patterns
            const allDeps = sharedState.parsed_outputs.flatMap((p) => p.dependencies || []);
            const streamKeywords = ['kafka', 'kinesis', 'flink', 'storm', 'streaming', 'realtime', 'pubsub'];
            if (allDeps.some((d) => streamKeywords.some((k) => d.toLowerCase().includes(k)))) {
                attributes.execution_pattern = 'streaming';
            }

            // Convert Set to Array
            attributes.frameworks_detected = Array.from(attributes.frameworks_detected);

            sharedState.mergeMetadata({
                datasets,
                schemas,
                attributes,
            });

            sharedState.updateStatus('processing', 'Metadata extracted', 65);

            return {
                success: true,
                datasetCount: datasets.length,
                schemaCount: Object.keys(schemas).length,
            };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    inferFormat(name, data) {
        if (!name) return 'unknown';
        const lower = name.toLowerCase();
        if (lower.endsWith('.csv')) return 'CSV';
        if (lower.endsWith('.json')) return 'JSON';
        if (lower.endsWith('.parquet')) return 'Parquet';
        if (lower.endsWith('.avro')) return 'Avro';
        if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'Excel';
        if (lower.endsWith('.tsv')) return 'TSV';
        if (lower.endsWith('.xml')) return 'XML';
        if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'YAML';
        if (data.type && data.type.includes('table')) return 'Database Table';
        if (data.type && data.type.includes('api')) return 'API';
        if (data.type && data.type.includes('spark')) return 'Spark DataFrame';
        return 'Unknown';
    }
}
