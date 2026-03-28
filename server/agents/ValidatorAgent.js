export class ValidatorAgent {
    constructor() {
        this.name = 'ValidatorAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Validating column-level lineage...', 80);

        try {
            const issues = [];
            const lineage = sharedState.lineage;

            if (lineage.nodes.length === 0) {
                issues.push({
                    type: 'warning',
                    category: 'empty_lineage',
                    message: 'No lineage datasets were extracted from the codebase.',
                    severity: 'high',
                });
            }

            // Check column-level constraints
            let totalColumnsMapped = 0;
            let lowConfidenceCount = 0;

            for (const node of lineage.nodes) {
                const colLineage = node.metadata?.column_lineage || [];
                
                for (const lin of colLineage) {
                    totalColumnsMapped++;

                    // Check 1: No orphan columns (missing source)
                    if (!lin.source_columns || lin.source_columns.length === 0) {
                        issues.push({
                            type: 'warning',
                            category: 'orphan_column',
                            message: `Output column "${lin.output_column}" in dataset "${node.label}" has no source columns mapped.`,
                            severity: 'medium',
                        });
                    }

                    // Check 2: Vague transformations
                    const vagueTerms = ['processed', 'transformed', 'changed', 'updated', 'data is transformed'];
                    if (vagueTerms.includes(lin.transformation?.toLowerCase())) {
                        issues.push({
                            type: 'warning',
                            category: 'vague_transformation',
                            message: `Transformation for "${lin.output_column}" is vague ("${lin.transformation}"). Needs explicit logic.`,
                            severity: 'medium',
                        });
                    }

                    // Check 3: Track confidence
                    if (lin.confidence === 'low') {
                        lowConfidenceCount++;
                    }
                }
            }

            if (totalColumnsMapped > 0 && lowConfidenceCount / totalColumnsMapped >= 0.5) {
                issues.push({
                    type: 'info',
                    category: 'low_confidence_lineage',
                    message: `More than 50% of column-lineage mappings have 'low' confidence. Verification recommended.`,
                    severity: 'low',
                });
            }
            
            if (lineage.nodes.length > 0 && lineage.edges.length === 0) {
                issues.push({
                    type: 'warning',
                    category: 'disconnected_lineage',
                    message: 'Datasets were extracted, but no flow/connections exist between them.',
                    severity: 'high',
                });
            }

            // Store validation results
            sharedState.validation = {
                valid: issues.filter((i) => i.severity === 'high').length === 0,
                issues,
                summary: {
                    total_issues: issues.length,
                    high: issues.filter((i) => i.severity === 'high').length,
                    medium: issues.filter((i) => i.severity === 'medium').length,
                    low: issues.filter((i) => i.severity === 'low').length,
                },
            };

            sharedState.updateStatus('processing', 'Validation complete', 85);

            return {
                success: true,
                valid: sharedState.validation.valid,
                issues: issues.length,
            };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }
}
