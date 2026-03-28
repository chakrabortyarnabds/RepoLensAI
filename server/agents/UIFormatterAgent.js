export class UIFormatterAgent {
    constructor() {
        this.name = 'UIFormatterAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Formatting output for UI...', 90);

        try {
            const { lineage, metadata, documentation } = sharedState;

            // Format lineage for dagre/D3 visualization
            const formattedLineage = {
                nodes: lineage.nodes.map((node) => ({
                    id: node.id,
                    label: node.label,
                    type: node.type,
                    color: this.getNodeColor(node.type),
                    shape: this.getNodeShape(node.type),
                    metadata: node.metadata || {},
                })),
                edges: lineage.edges.map((edge) => ({
                    source: edge.source,
                    target: edge.target,
                    label: edge.label || '',
                })),
            };

            // Format transformations
            const formattedTransformations = (documentation.transformations || []).map((t, i) => ({
                id: i + 1,
                name: t.name,
                description: t.description,
                input_data: t.input_data,
                output_data: t.output_data,
                entity: t.entity || '',
            }));

            // Format metadata
            const formattedMetadata = {
                datasets: metadata.datasets.map((d) => ({
                    name: d.name,
                    type: d.type,
                    format: d.format,
                    source_file: d.source_file,
                    framework: d.framework,
                })),
                schemas: Object.entries(metadata.schemas).map(([table, schema]) => ({
                    table,
                    columns: schema.columns,
                    source_file: schema.source_file,
                })),
                attributes: metadata.attributes,
            };

            // Build the final output contract
            const finalOutput = {
                summary: documentation.summary || 'No summary was generated for this repository.',
                detail_flow: documentation.detail_flow || [],
                steps: documentation.steps || [],
                lineage: formattedLineage,
                transformations: formattedTransformations,
                metadata: formattedMetadata,
                validation: sharedState.validation || { valid: true, issues: [] },
                stats: {
                    total_files: sharedState.repo_index.files.length,
                    languages: sharedState.repo_index.languages_detected,
                    total_nodes: lineage.nodes.length,
                    total_edges: lineage.edges.length,
                    total_datasets: metadata.datasets.length,
                    total_transformations: formattedTransformations.length,
                    analyzed_at: new Date().toISOString(),
                },
            };

            sharedState.final_output = finalOutput;
            sharedState.updateStatus('completed', 'Analysis complete', 100);

            return { success: true };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    getNodeColor(type) {
        const colors = {
            data_source: '#3B82F6',     // Blue
            data_sink: '#10B981',       // Green
            file: '#8B5CF6',            // Purple
            transformation: '#F59E0B',  // Amber
            dependency: '#6B7280',      // Gray
        };
        return colors[type] || '#6B7280';
    }

    getNodeShape(type) {
        const shapes = {
            data_source: 'cylinder',
            data_sink: 'cylinder',
            file: 'rect',
            transformation: 'diamond',
            dependency: 'ellipse',
        };
        return shapes[type] || 'rect';
    }
}
