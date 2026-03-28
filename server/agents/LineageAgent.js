/**
 * LineageAgent — Builds a data lineage DAG.
 * 
 * Supports TWO input modes:
 * 1. LLM-extracted data (primary) — structured datasets + column_lineage from LLMExtractorAgent
 * 2. Deterministic parsed_outputs (fallback) — uses function-scoped entity tagging
 *    from PythonParser to create entity-accurate edges (NOT cartesian product).
 */
export class LineageAgent {
    constructor() {
        this.name = 'LineageAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Building data lineage graph...', 50);

        try {
            const extracted = sharedState.llm_extracted_data || { datasets: [], column_lineage: [] };
            const hasLLMData = extracted.datasets && extracted.datasets.length > 0;

            if (hasLLMData) {
                console.log(`[LineageAgent] Using LLM-extracted data (${extracted.datasets.length} datasets, ${extracted.column_lineage.length} column mappings)`);
                this.buildFromLLM(sharedState, extracted);
            } else {
                console.log(`[LineageAgent] Using deterministic parsed_outputs (${sharedState.parsed_outputs.length} files)`);
                this.buildFromParsedOutputs(sharedState);
            }

            sharedState.updateStatus('processing', 'Lineage graph built', 55);
            return { success: true, nodeCount: sharedState.lineage.nodes.length, edgeCount: sharedState.lineage.edges.length };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    // ===================== LLM PATH =====================
    buildFromLLM(sharedState, extracted) {
        const tables = new Map();
        const edges = [];
        const edgeSet = new Set();

        for (const ds of extracted.datasets) {
            const id = this.normalizeId(ds.name);
            tables.set(id, {
                id,
                label: this.createLabel(ds.name),
                type: ds.type === 'input' ? 'data_source' : 'data_sink',
                color: this.getNodeColor(ds),
                metadata: {
                    format: ds.format || 'unknown',
                    zone: ds.zone || 'unknown',
                    columns: ds.columns || [],
                    column_lineage: [],
                    entity: this.inferEntity(ds.name)
                }
            });
        }

        for (const lin of extracted.column_lineage) {
            if (!lin.source_dataset || !lin.target_dataset) continue;
            const srcId = this.normalizeId(lin.source_dataset);
            const tgtId = this.normalizeId(lin.target_dataset);

            if (!tables.has(srcId)) tables.set(srcId, this.createPlaceholderNode(srcId, lin.source_dataset, 'data_source'));
            if (!tables.has(tgtId)) tables.set(tgtId, this.createPlaceholderNode(tgtId, lin.target_dataset, 'data_sink'));

            const edgeKey = `${srcId}->${tgtId}`;
            if (!edgeSet.has(edgeKey) && srcId !== tgtId) {
                edges.push({ source: srcId, target: tgtId, label: 'Transform' });
                edgeSet.add(edgeKey);
            }

            const targetTable = tables.get(tgtId);
            targetTable.metadata.column_lineage.push({
                output_column: lin.output_column,
                source_columns: lin.source_columns || [],
                transformation: lin.transformation || 'direct mapping',
                source_dataset: lin.source_dataset,
                confidence: lin.confidence || 'low'
            });

            if (!targetTable.metadata.columns.find(c => c.name === lin.output_column)) {
                targetTable.metadata.columns.push({ name: lin.output_column, dataType: 'unknown' });
            }
        }

        const allNodes = Array.from(tables.values());
        const nodeIds = new Set(allNodes.map(n => n.id));
        const finalEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
        sharedState.mergeLineage({ nodes: allNodes, edges: finalEdges });
    }

    // ===================== FALLBACK: DETERMINISTIC PATH =====================
    buildFromParsedOutputs(sharedState) {
        const tables = new Map();
        const edges = [];
        const edgeSet = new Set();
        const allSqlSchemas = {};

        // ========= PASS 1: Register ALL input/output nodes & collect schemas =========
        for (const parsed of sharedState.parsed_outputs) {
            const sqlSchemas = parsed.columns?._schemas || {};
            for (const [tblName, cols] of Object.entries(sqlSchemas)) {
                allSqlSchemas[tblName] = cols;
            }

            for (const input of (parsed.inputs || [])) {
                const source = input.source || input.type;
                if (!source || source === 'unknown') continue;
                const tableId = this.normalizeId(source);
                if (!tables.has(tableId)) {
                    tables.set(tableId, this.createTableNode(tableId, source, 'source', input));
                }
                const tbl = tables.get(tableId);
                if (!tbl.files.includes(parsed.file)) tbl.files.push(parsed.file);
            }

            for (const output of (parsed.outputs || [])) {
                const target = output.target || output.type;
                if (!target || target === 'unknown') continue;
                const tableId = this.normalizeId(target);
                if (!tables.has(tableId)) {
                    tables.set(tableId, this.createTableNode(tableId, target, 'target', output));
                }
                const tbl = tables.get(tableId);
                if (!tbl.files.includes(parsed.file)) tbl.files.push(parsed.file);
            }

            for (const step of (parsed.intermediate_steps || [])) {
                if (step.type === 'upsert' && step.source && step.target) {
                    const srcId = this.normalizeId(step.source);
                    const tgtId = this.normalizeId(step.target);
                    if (!tables.has(srcId)) {
                        tables.set(srcId, this.createTableNode(srcId, step.source, 'source', { framework: 'redshift', format: 'Staging Table' }));
                    }
                    if (!tables.has(tgtId)) {
                        tables.set(tgtId, this.createTableNode(tgtId, step.target, 'target', { framework: 'redshift', format: 'Warehouse Table' }));
                    }
                }
            }
        }

        // ========= PASS 2: Apply Columns and Schemas to All Nodes =========
        for (const [schemaTable, schemaCols] of Object.entries(allSqlSchemas)) {
            const matchingTables = [...tables.entries()].filter(([id]) =>
                id.includes(schemaTable.toLowerCase()) || id.includes(this.normalizeId(schemaTable))
            );
            for (const [, tbl] of matchingTables) {
                for (const col of schemaCols) {
                    if (!tbl.columns.find(c => c.name === col.name)) tbl.columns.push(col);
                }
            }
        }

        for (const parsed of sharedState.parsed_outputs) {
            const fileColumns = parsed.columns?._detected || [];
            if (fileColumns.length > 0) {
                for (const output of (parsed.outputs || [])) {
                    const target = output.target || output.type;
                    if (!target || target === 'unknown') continue;
                    const tbl = tables.get(this.normalizeId(target));
                    if (tbl) {
                        for (const col of fileColumns) {
                            if (!tbl.columns.find(c => c.name === col.name)) tbl.columns.push(col);
                        }
                    }
                }
            }
            for (const output of (parsed.outputs || [])) {
                if (output.columns?.length > 0) {
                    const target = output.target || output.type;
                    if (!target || target === 'unknown') continue;
                    const tbl = tables.get(this.normalizeId(target));
                    if (tbl) {
                        for (const col of output.columns) {
                            if (!tbl.columns.find(c => c.name === col.name)) tbl.columns.push(col);
                        }
                    }
                }
            }
        }

        // ========= PASS 3: Generate Function-Scoped Edges =========
        for (const parsed of sharedState.parsed_outputs) {
            const functionScopes = parsed.function_scopes || {};
            const scopeNames = Object.keys(functionScopes);

            if (scopeNames.length > 0) {
                for (const [funcName, scope] of Object.entries(functionScopes)) {
                    const scopeInputIds = scope.inputs.map(i => this.normalizeId(i.source || i.type)).filter(id => id !== 'unknown');
                    const scopeOutputIds = scope.outputs.map(o => this.normalizeId(o.target || o.type)).filter(id => id !== 'unknown');
                    const transformLabel = this.buildScopeTransformLabel(scope.transforms);

                    for (const srcId of scopeInputIds) {
                        for (const tgtId of scopeOutputIds) {
                            if (srcId === tgtId) continue;
                            this.addEdge(edges, edgeSet, srcId, tgtId, transformLabel, parsed.file);
                        }
                    }
                }
            } else {
                const inputs = (parsed.inputs || []).map(i => ({ id: this.normalizeId(i.source || i.type), entity: i.entity || this.inferEntity(i.source || i.type) })).filter(i => i.id !== 'unknown');
                const outputs = (parsed.outputs || []).map(o => ({ id: this.normalizeId(o.target || o.type), entity: o.entity || this.inferEntity(o.target || o.type) })).filter(o => o.id !== 'unknown');

                let hasEntityMatch = false;
                for (const src of inputs) {
                    for (const tgt of outputs) {
                        if (src.id === tgt.id) continue;
                        if (src.entity && tgt.entity && this.entitiesMatch(src.entity, tgt.entity)) {
                            this.addEdge(edges, edgeSet, src.id, tgt.id, '', parsed.file);
                            hasEntityMatch = true;
                        }
                    }
                }

                if (!hasEntityMatch && inputs.length <= 2 && outputs.length <= 2) {
                    for (const src of inputs) {
                        for (const tgt of outputs) {
                            if (src.id !== tgt.id) {
                                this.addEdge(edges, edgeSet, src.id, tgt.id, '', parsed.file);
                            }
                        }
                    }
                }
            }

            for (const step of (parsed.intermediate_steps || [])) {
                if (step.type === 'upsert' && step.source && step.target) {
                    const srcId = this.normalizeId(step.source);
                    const tgtId = this.normalizeId(step.target);
                    this.addEdge(edges, edgeSet, srcId, tgtId, 'Upsert', '');
                }
            }
        }

        // ========= STEP 4: Entity-flow edges (zone progression) =========
        this.buildEntityFlowEdges(tables, edges, edgeSet);

        // ========= STEP 5: Build final nodes =========
        const connectedIds = new Set();
        for (const e of edges) { connectedIds.add(e.source); connectedIds.add(e.target); }

        const allNodes = [];
        for (const [id, table] of tables) {
            if (connectedIds.has(id) || tables.size <= 20) {
                allNodes.push({
                    id: table.id,
                    label: table.label,
                    type: table.type === 'source' ? 'data_source' : 'data_sink',
                    color: this.getNodeColor(table),
                    metadata: {
                        format: table.format,
                        framework: table.framework,
                        path: table.path,
                        columns: table.columns,
                        files: table.files,
                        zone: table.zone,
                        entity: table.entity,
                    },
                });
            }
        }

        const nodeIds = new Set(allNodes.map(n => n.id));
        const finalEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
        sharedState.mergeLineage({ nodes: allNodes, edges: finalEdges });
    }

    // ===================== ENTITY FLOW EDGES =====================
    buildEntityFlowEdges(tables, edges, edgeSet) {
        // Group tables by entity
        const entityTables = new Map();
        for (const [id, table] of tables) {
            const entity = table.entity;
            if (!entity) continue;
            if (!entityTables.has(entity)) entityTables.set(entity, []);
            entityTables.get(entity).push({ id, ...table });
        }

        const zoneOrder = ['landing zone', 'raw', 'working zone', 'bronze', 'processed zone', 'silver', 'staging', 'warehouse', 'gold'];

        for (const [entity, entityNodes] of entityTables) {
            if (entityNodes.length <= 1) continue;

            const sorted = entityNodes.sort((a, b) => {
                const aIdx = zoneOrder.findIndex(z => (a.zone || '').toLowerCase().includes(z));
                const bIdx = zoneOrder.findIndex(z => (b.zone || '').toLowerCase().includes(z));
                return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });

            // Connect consecutive zones for same entity
            const uniqueFlow = [];
            const seen = new Set();
            for (const node of sorted) {
                if (!seen.has(node.id)) {
                    uniqueFlow.push(node);
                    seen.add(node.id);
                }
            }
            for (let i = 0; i < uniqueFlow.length - 1; i++) {
                const src = uniqueFlow[i];
                const tgt = uniqueFlow[i + 1];
                if (src.id !== tgt.id) {
                    const label = this.inferFlowLabel(src.zone, tgt.zone);
                    this.addEdge(edges, edgeSet, src.id, tgt.id, label, '');
                }
            }
        }
    }

    // ===================== HELPERS =====================
    buildScopeTransformLabel(transforms) {
        if (!transforms || transforms.length === 0) return '';
        const types = [...new Set(transforms.map(t => t.description || t.type))].slice(0, 3);
        return types.join(', ');
    }

    entitiesMatch(a, b) {
        if (!a || !b) return false;
        const cleanA = a.toLowerCase().replace(/s$/, '').replace(/[-_]/g, '');
        const cleanB = b.toLowerCase().replace(/s$/, '').replace(/[-_]/g, '');
        return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
    }

    createPlaceholderNode(id, name, type) {
        return {
            id, label: this.createLabel(name), type,
            color: type === 'data_source' ? '#3B82F6' : '#10B981',
            metadata: {
                format: 'unknown', zone: 'unknown', columns: [], column_lineage: [],
                entity: this.inferEntity(name)
            }
        };
    }

    createTableNode(id, name, role, meta = {}) {
        return {
            id, label: this.createLabel(name), type: role,
            format: meta.format || this.inferFormat(name),
            framework: meta.framework || 'unknown',
            path: meta.path || name,
            columns: [], files: [],
            zone: meta.zone || this.inferZone(name, role),
            entity: meta.entity || this.inferEntity(name),
        };
    }

    getNodeColor(table) {
        const zone = (table.zone || '').toLowerCase();
        if (zone.includes('landing') || zone.includes('raw')) return '#F59E0B';
        if (zone.includes('working')) return '#3B82F6';
        if (zone.includes('processed') || zone.includes('silver')) return '#8B5CF6';
        if (zone.includes('staging')) return '#06B6D4';
        if (zone.includes('warehouse') || zone.includes('gold')) return '#10B981';
        if (table.type === 'source' || table.type === 'data_source') return '#3B82F6';
        return '#10B981';
    }

    inferFlowLabel(srcZone, tgtZone) {
        const src = (srcZone || '').toLowerCase();
        const tgt = (tgtZone || '').toLowerCase();
        if (src.includes('landing') && tgt.includes('working')) return 'Copy to Working Zone';
        if (src.includes('working') && tgt.includes('processed')) return 'Transform & Deduplicate';
        if (src.includes('processed') && tgt.includes('staging')) return 'Load to Staging';
        if (src.includes('staging') && tgt.includes('warehouse')) return 'Upsert to Warehouse';
        if (src.includes('raw') && tgt.includes('bronze')) return 'Ingest';
        if (src.includes('bronze') && tgt.includes('silver')) return 'Clean & Transform';
        if (src.includes('silver') && tgt.includes('gold')) return 'Aggregate & Enrich';
        return 'Transform';
    }

    normalizeId(name) {
        if (!name) return 'unknown';
        return name.toLowerCase().replace(/['"` ]/g, '').replace(/\\/g, '/').replace(/\s+/g, '_').replace(/[^a-z0-9_./\\-]/g, '').replace(/^\.\//, '').replace(/\/$/, '');
    }

    createLabel(name) {
        if (!name) return 'Unknown';
        let label = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() || name;
        label = label.replace(/\.(csv|parquet|json|avro|orc|delta|txt)$/i, '');
        return label.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    inferFormat(name) {
        if (!name) return 'unknown';
        const lower = name.toLowerCase();
        if (lower.endsWith('.csv') || lower.includes('csv')) return 'CSV';
        if (lower.endsWith('.parquet')) return 'Parquet';
        if (lower.endsWith('.json')) return 'JSON';
        if (lower.includes('delta')) return 'Delta';
        if (lower.includes('staging')) return 'Staging Table';
        if (lower.includes('warehouse')) return 'Warehouse Table';
        return 'unknown';
    }

    inferZone(name, role) {
        const lower = (name || '').toLowerCase();
        if (lower.includes('landing')) return 'landing zone';
        if (lower.includes('raw')) return 'raw';
        if (lower.includes('working')) return 'working zone';
        if (lower.includes('bronze')) return 'bronze';
        if (lower.includes('processed')) return 'processed zone';
        if (lower.includes('silver')) return 'silver';
        if (lower.includes('staging')) return 'staging';
        if (lower.includes('warehouse')) return 'warehouse';
        if (lower.includes('gold')) return 'gold';
        return role === 'source' ? 'source' : 'destination';
    }

    inferEntity(name) {
        const lower = (name || '').toLowerCase();
        const parts = lower.replace(/\\/g, '/').split('/').filter(Boolean);
        for (const part of parts.reverse()) {
            const clean = part.replace(/\.\w+$/, '').replace(/[-_]/g, '');
            if (clean.length > 1 &&
                !['s3', 'abfss', 'mnt', 'dbfs', 'tmp', 'zone', 'bucket', 'staging', 'warehouse', 'processed', 'working', 'landing', 'raw', 'bronze', 'silver', 'gold'].includes(clean)) {
                return part.replace(/\.\w+$/, '');
            }
        }
        return null;
    }

    addEdge(edges, edgeSet, source, target, label, file) {
        const key = `${source}->${target}`;
        if (!edgeSet.has(key) && source !== target) {
            edges.push({ source, target, label: label || '', file });
            edgeSet.add(key);
        }
    }
}
