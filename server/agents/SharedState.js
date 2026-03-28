import EventEmitter from 'events';

export class SharedState extends EventEmitter {
    constructor(jobId) {
        super();
        this.jobId = jobId;
        this.createdAt = new Date().toISOString();
        this.status = 'pending';
        this.progress = 0;
        this.currentStep = '';
        this.errors = [];

        this.repo_index = {
            files: [],
            languages_detected: [],
            project_structure: {},
            tempDir: null,
        };

        this.execution_plan = {
            task_graph: [],
            parser_assignments: {},
        };

        this.parsed_outputs = [];

        this.lineage = {
            nodes: [],
            edges: [],
        };

        this.metadata = {
            datasets: [],
            schemas: {},
            attributes: {},
        };

        this.documentation = {
            summary: '',
            steps: [],
            transformations: [],
        };

        this.final_output = null;
    }

    updateStatus(status, step, progress) {
        this.status = status;
        if (step) this.currentStep = step;
        if (progress !== undefined) this.progress = progress;
        this.emit('statusChange', {
            status: this.status,
            step: this.currentStep,
            progress: this.progress,
        });
    }

    addError(agentName, error) {
        this.errors.push({
            agent: agentName,
            message: error.message || error,
            timestamp: new Date().toISOString(),
        });
    }

    mergeRepoIndex(data) {
        if (data.files) {
            this.repo_index.files = [...this.repo_index.files, ...data.files];
        }
        if (data.languages_detected) {
            this.repo_index.languages_detected = [
                ...new Set([...this.repo_index.languages_detected, ...data.languages_detected]),
            ];
        }
        if (data.project_structure) {
            this.repo_index.project_structure = {
                ...this.repo_index.project_structure,
                ...data.project_structure,
            };
        }
        if (data.tempDir) {
            this.repo_index.tempDir = data.tempDir;
        }
    }

    mergeParsedOutput(output) {
        this.parsed_outputs.push(output);
    }

    mergeLineage(data) {
        if (data.nodes) {
            const existingIds = new Set(this.lineage.nodes.map((n) => n.id));
            for (const node of data.nodes) {
                if (!existingIds.has(node.id)) {
                    this.lineage.nodes.push(node);
                    existingIds.add(node.id);
                }
            }
        }
        if (data.edges) {
            const existingEdgeKeys = new Set(
                this.lineage.edges.map((e) => `${e.source}->${e.target}`)
            );
            for (const edge of data.edges) {
                const key = `${edge.source}->${edge.target}`;
                if (!existingEdgeKeys.has(key)) {
                    this.lineage.edges.push(edge);
                    existingEdgeKeys.add(key);
                }
            }
        }
    }

    mergeMetadata(data) {
        if (data.datasets) {
            const existingNames = new Set(this.metadata.datasets.map((d) => d.name));
            for (const ds of data.datasets) {
                if (!existingNames.has(ds.name)) {
                    this.metadata.datasets.push(ds);
                    existingNames.add(ds.name);
                }
            }
        }
        if (data.schemas) {
            this.metadata.schemas = { ...this.metadata.schemas, ...data.schemas };
        }
        if (data.attributes) {
            this.metadata.attributes = { ...this.metadata.attributes, ...data.attributes };
        }
    }

    mergeDocumentation(data) {
        if (data.summary) this.documentation.summary = data.summary;
        if (data.steps) this.documentation.steps = data.steps;
        if (data.transformations) this.documentation.transformations = data.transformations;
    }

    getSnapshot() {
        return {
            jobId: this.jobId,
            status: this.status,
            progress: this.progress,
            currentStep: this.currentStep,
            errors: this.errors,
            repo_index: {
                fileCount: this.repo_index.files.length,
                languages_detected: this.repo_index.languages_detected,
            },
            parsed_outputs_count: this.parsed_outputs.length,
            lineage_node_count: this.lineage.nodes.length,
            lineage_edge_count: this.lineage.edges.length,
        };
    }
}
