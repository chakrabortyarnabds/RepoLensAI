import { callGemini, extractJSON } from '../utils/gemini.js';

export class ExplainerAgent {
    constructor() {
        this.name = 'ExplainerAgent';
    }

    async execute(sharedState) {
        sharedState.updateStatus('processing', 'Generating documentation...', 70);

        try {
            const lineage = sharedState.lineage;
            const metadata = sharedState.metadata;
            const parsedOutputs = sharedState.parsed_outputs;

            let documentation;
            try {
                documentation = await this.generateWithLLM(lineage, metadata, parsedOutputs, sharedState.repo_index);
            } catch (error) {
                console.warn('[ExplainerAgent] LLM explanation failed, using template:', error.message);
                documentation = null;
            }

            if (!documentation) {
                documentation = this.generateTemplate(lineage, metadata, parsedOutputs);
            }

            sharedState.mergeDocumentation(documentation);
            sharedState.updateStatus('processing', 'Documentation generated', 75);

            return { success: true };
        } catch (error) {
            sharedState.addError(this.name, error);
            throw error;
        }
    }

    async generateWithLLM(lineage, metadata, parsedOutputs, repoIndex) {
        const context = this.buildContext(lineage, metadata, parsedOutputs, repoIndex);

        const prompt = `You are a senior data engineer explaining a data pipeline to a team member who wants to understand the code.

Here is extracted information about a data pipeline repository:

${context}

Generate a JSON response with EXACTLY this structure:
{
  "summary": "A detailed 3-8 sentence paragraph explaining what this pipeline does, what data it processes, and the overall architecture. Mention specific entity names (like authors, books, users, reviews, etc.) and the technologies used. This should read like a technical README.",
  "detail_flow": [
    "Step 1: Data is collected from [specific source] and lands in [specific location].",
    "Step 2: The [specific entity] dataset is read from [zone], deduplicated by [method], and written to [zone].",
    ...
  ],
  "steps": [
    {
      "step_number": 1,
      "title": "Step title describing the action",
      "description": "Detailed description explaining what happens, mentioning specific entity names, transformations applied, and where data moves. Should be 2-3 sentences.",
      "input": "Specific data source (e.g., 'author.csv from S3 Working Zone')",
      "output": "Specific destination (e.g., 'Deduplicated authors in S3 Processed Zone')"
    }
  ],
  "transformations": [
    {
      "name": "Transformation name",
      "description": "What this transformation does and WHY, mentioning specific columns or entities when possible",
      "input_data": "What data goes in",
      "output_data": "What data comes out",
      "entity": "Which entity this applies to (e.g., 'authors', 'reviews')"
    }
  ]
}

CRITICAL RULES:
- Be SPECIFIC: mention actual entity names (authors, books, reviews, users, etc.)
- Mention the actual data zones (Landing Zone, Working Zone, Processed Zone, Staging, Warehouse)
- Explain the WHY behind transformations (e.g., "Deduplication ensures only the latest record for each author is kept")
- Each step should clearly state WHERE data comes from and WHERE it goes
- The detail_flow should read like a story, each step building on the previous one
- Use technical terminology but make it clear (e.g., "UPSERT operation (insert new records, update existing ones)")
- Include ALL entities and ALL stages of the pipeline`;

        const response = await callGemini(prompt, { maxTokens: 6144 });
        const parsed = extractJSON(response);

        if (!parsed || !parsed.summary) {
            throw new Error('Failed to parse LLM response');
        }

        return parsed;
    }

    buildContext(lineage, metadata, parsedOutputs, repoIndex) {
        let context = '';

        context += `Languages: ${repoIndex.languages_detected.join(', ')}\n`;
        context += `Total files analyzed: ${repoIndex.files.length}\n\n`;

        // Files and their purposes
        context += 'Key files:\n';
        for (const file of repoIndex.files.slice(0, 30)) {
            context += `  - ${file.path} (${file.language})\n`;
        }
        context += '\n';

        // Datasets
        if (metadata.datasets.length > 0) {
            context += 'Datasets found:\n';
            for (const ds of metadata.datasets) {
                context += `  - ${ds.name} (type: ${ds.type}, format: ${ds.format}, source: ${ds.source_file})\n`;
            }
            context += '\n';
        }

        // Lineage nodes with zones
        if (lineage.nodes.length > 0) {
            context += 'Data flow nodes (tables/datasets):\n';
            for (const node of lineage.nodes.slice(0, 30)) {
                const zone = node.metadata?.zone || '';
                const cols = node.metadata?.columns?.length || 0;
                context += `  - ${node.label} (${node.type}, zone: ${zone}, ${cols} columns)\n`;
            }
            context += '\n';
        }

        // Lineage edges
        if (lineage.edges.length > 0) {
            context += 'Data flow connections:\n';
            for (const edge of lineage.edges.slice(0, 30)) {
                context += `  ${edge.source} --[${edge.label}]--> ${edge.target}\n`;
            }
            context += '\n';
        }

        // Transformations by file
        for (const parsed of parsedOutputs) {
            if ((parsed.transformations || []).length > 0 || (parsed.intermediate_steps || []).length > 0) {
                context += `File: ${parsed.file}\n`;
                for (const t of (parsed.transformations || []).slice(0, 10)) {
                    context += `  Transform: ${t.type} - ${t.description}\n`;
                }
                for (const s of (parsed.intermediate_steps || []).slice(0, 10)) {
                    context += `  Step: ${s.type} - ${s.description}\n`;
                }
                context += '\n';
            }
        }

        // Inputs and outputs
        const allInputs = parsedOutputs.flatMap(p => p.inputs || []);
        const allOutputs = parsedOutputs.flatMap(p => p.outputs || []);
        if (allInputs.length > 0) {
            context += 'All data sources:\n';
            for (const input of allInputs.slice(0, 20)) {
                context += `  - ${input.source || input.type} (${input.framework || 'unknown'}, format: ${input.format || 'unknown'}, zone: ${input.zone || 'unknown'})\n`;
            }
            context += '\n';
        }
        if (allOutputs.length > 0) {
            context += 'All data destinations:\n';
            for (const output of allOutputs.slice(0, 20)) {
                context += `  - ${output.target || output.type} (${output.framework || 'unknown'}, format: ${output.format || 'unknown'}, zone: ${output.zone || 'unknown'})\n`;
            }
        }

        // Schemas from SQL DDL
        if (Object.keys(metadata.schemas || {}).length > 0) {
            context += '\nTable schemas:\n';
            for (const [table, schema] of Object.entries(metadata.schemas)) {
                const colStr = (schema.columns || []).map(c => `${c.name} (${c.type || c.dataType || ''})`).join(', ');
                context += `  ${table}: ${colStr}\n`;
            }
        }

        return context;
    }

    generateTemplate(lineage, metadata, parsedOutputs) {
        const allInputs = parsedOutputs.flatMap(p => p.inputs || []);
        const allOutputs = parsedOutputs.flatMap(p => p.outputs || []);
        const allTransforms = parsedOutputs.flatMap(p => p.transformations || []);
        const allSteps = parsedOutputs.flatMap(p => p.intermediate_steps || []);

        // --- Build entity map from function_scopes (preferred) or fallback ---
        const entities = new Map();

        // First try function_scopes for accurate entity mapping
        for (const parsed of parsedOutputs) {
            const scopes = parsed.function_scopes || {};
            for (const [funcName, scope] of Object.entries(scopes)) {
                for (const inp of (scope.inputs || [])) {
                    const entity = inp.entity || this.inferEntity(inp.source || inp.type);
                    if (entity) {
                        if (!entities.has(entity)) entities.set(entity, { inputs: [], outputs: [], transforms: [], scope: funcName });
                        entities.get(entity).inputs.push(inp);
                    }
                }
                for (const out of (scope.outputs || [])) {
                    const entity = out.entity || this.inferEntity(out.target || out.type);
                    if (entity) {
                        if (!entities.has(entity)) entities.set(entity, { inputs: [], outputs: [], transforms: [], scope: funcName });
                        entities.get(entity).outputs.push(out);
                    }
                }
                for (const t of (scope.transforms || [])) {
                    // Attach transforms to all entities in this scope
                    const scopeEntities = [...new Set([
                        ...(scope.inputs || []).map(i => i.entity || this.inferEntity(i.source || i.type)),
                        ...(scope.outputs || []).map(o => o.entity || this.inferEntity(o.target || o.type)),
                    ])].filter(Boolean);
                    for (const entity of scopeEntities) {
                        if (!entities.has(entity)) entities.set(entity, { inputs: [], outputs: [], transforms: [], scope: funcName });
                        entities.get(entity).transforms.push(t);
                    }
                }
            }
        }

        // Fallback: if no scoped entities, use flat inputs/outputs
        if (entities.size === 0) {
            for (const inp of allInputs) {
                const entity = inp.entity || this.inferEntity(inp.source || inp.type);
                if (entity) {
                    if (!entities.has(entity)) entities.set(entity, { inputs: [], outputs: [], transforms: [] });
                    entities.get(entity).inputs.push(inp);
                }
            }
            for (const out of allOutputs) {
                const entity = out.entity || this.inferEntity(out.target || out.type);
                if (entity) {
                    if (!entities.has(entity)) entities.set(entity, { inputs: [], outputs: [], transforms: [] });
                    entities.get(entity).outputs.push(out);
                }
            }
        }

        // --- Summary ---
        const entityNames = [...entities.keys()];
        const inputNames = [...new Set(allInputs.map(i => i.source || i.type))].slice(0, 8);
        const outputNames = [...new Set(allOutputs.map(o => o.target || o.type))].slice(0, 8);

        let summary = '';
        if (entityNames.length > 0) {
            summary += `This data pipeline processes ${entityNames.length} core entities: ${this.formatList(entityNames)}. `;
        } else {
            summary += 'This project processes data through a series of automated steps. ';
        }

        if (allInputs.length > 0) {
            const frameworks = [...new Set(allInputs.map(i => i.framework).filter(Boolean))];
            summary += `Data is ingested from ${this.formatList(inputNames.slice(0, 4))}`;
            if (frameworks.length > 0) summary += ` using ${this.formatList(frameworks)}`;
            summary += '. ';
        }

        if (allTransforms.length > 0) {
            const types = [...new Set(allTransforms.map(t => this.friendlyTransformName(t.type)))].slice(0, 5);
            summary += `The pipeline applies ${types.join(', ')} transformations. `;
        }

        if (allOutputs.length > 0) {
            summary += `Processed data is written to ${this.formatList(outputNames.slice(0, 4))}. `;
        }

        if (allSteps.length > 0) {
            const warehouseSteps = allSteps.filter(s => s.type === 'warehouse_operation' || s.type === 'upsert');
            if (warehouseSteps.length > 0) {
                summary += 'Finally, data is loaded into staging tables and upserted into the data warehouse for analytics. ';
            }
        }

        // --- Detail Flow ---
        const detail_flow = this.buildDetailFlow(allInputs, allOutputs, allTransforms, allSteps, entities);

        // --- Steps ---
        const steps = this.buildSteps(allInputs, allOutputs, allTransforms, allSteps, entities, parsedOutputs);

        // --- Transformations grouped by entity ---
        const transformations = this.buildTransformationList(allTransforms, parsedOutputs, entities);

        return { summary, detail_flow, steps, transformations };
    }

    buildDetailFlow(allInputs, allOutputs, allTransforms, allSteps, entities) {
        const flow = [];
        let stepNum = 1;

        // S3 movement
        const s3Moves = allSteps.filter(s => s.type === 's3_data_movement');
        if (s3Moves.length > 0) {
            for (const move of s3Moves) {
                flow.push(`Step ${stepNum++}: Data files are copied from the ${move.source} to the ${move.target} for processing.`);
            }
        }

        // Per-entity processing
        for (const [entity, data] of entities) {
            const inputZones = [...new Set(data.inputs.map(i => i.zone).filter(Boolean))];
            const outputZones = [...new Set(data.outputs.map(o => o.zone).filter(Boolean))];
            const inputFormats = [...new Set(data.inputs.map(i => i.format).filter(Boolean))];

            let desc = `Step ${stepNum++}: The "${entity}" dataset is `;
            if (inputZones.length > 0 && inputFormats.length > 0) {
                desc += `read as ${inputFormats[0]} from the ${inputZones[0]}`;
            } else if (data.inputs.length > 0) {
                desc += `read from ${data.inputs[0].source || 'the source'}`;
            }
            desc += ', processed';
            if (outputZones.length > 0) {
                desc += `, and written to the ${outputZones.join(' → ')}`;
            }
            desc += '.';
            flow.push(desc);
        }

        // Warehouse operations
        const warehouseOps = allSteps.filter(s => s.type === 'warehouse_operation');
        if (warehouseOps.length > 0) {
            for (const op of warehouseOps) {
                flow.push(`Step ${stepNum++}: ${op.description}.`);
            }
        }

        // Upserts
        const upserts = allSteps.filter(s => s.type === 'upsert');
        if (upserts.length > 0) {
            const entities = [...new Set(upserts.map(u => u.entity).filter(Boolean))];
            if (entities.length > 0) {
                flow.push(`Step ${stepNum++}: Upsert operations update the warehouse tables for ${this.formatList(entities)}: existing records are replaced, new records are inserted.`);
            }
        }

        return flow;
    }

    buildSteps(allInputs, allOutputs, allTransforms, allSteps, entities, parsedOutputs = []) {
        const steps = [];
        let stepNum = 1;

        // Data movement step
        const s3Moves = allSteps.filter(s => s.type === 's3_data_movement');
        if (s3Moves.length > 0) {
            steps.push({
                step_number: stepNum++,
                title: 'Ingest: Landing Zone → Working Zone',
                description: `Raw data files (CSVs) are copied from the S3 Landing Zone to the Working Zone. This makes the data available for processing without modifying the original source files.`,
                input: 'Raw CSVs in S3 Landing Zone',
                output: 'CSVs in S3 Working Zone',
            });
        }

        // Per-entity transform steps — with ENTITY-SPECIFIC transform descriptions
        for (const [entity, data] of entities) {
            if (data.inputs.length > 0) {
                const inputSources = data.inputs.map(i => i.source || i.type).join(', ');
                const inputFormat = data.inputs[0]?.format || 'CSV';
                const outputTarget = data.outputs.length > 0 ? data.outputs.map(o => o.target || o.type).join(', ') : 'processed zone';

                // Build entity-specific transform descriptions from scope data
                const entityTransforms = data.transforms || [];
                let transformDesc = '';
                if (entityTransforms.length > 0) {
                    const uniqueTypes = [...new Set(entityTransforms.map(t => t.description || t.type))];
                    transformDesc = uniqueTypes.slice(0, 5).join('; ');
                } else {
                    transformDesc = 'deduplication and data cleaning';
                }

                // Infer the dedup key from entity name
                const dedupKey = this.inferDedupKey(entity);

                steps.push({
                    step_number: stepNum++,
                    title: `Transform: ${this.capitalize(entity)} Data`,
                    description: `Read the ${entity} dataset (${inputFormat}) from ${inputSources}. Deduplicate by ${dedupKey} using the latest record_create_timestamp. Apply: ${transformDesc}. Output is repartitioned and compressed (gzip), then written to ${outputTarget}.`,
                    input: `${inputSources} (${inputFormat})`,
                    output: `${outputTarget}`,
                });
            }
        }

        // Warehouse steps — more descriptive
        const warehouseOps = allSteps.filter(s => s.type === 'warehouse_operation');
        for (const op of warehouseOps) {
            steps.push({
                step_number: stepNum++,
                title: this.capitalize(op.description.replace(/\.$/, '')),
                description: op.description,
                input: 'Processed data from S3',
                output: 'Redshift tables',
            });
        }

        // Upsert
        const upserts = allSteps.filter(s => s.type === 'upsert');
        if (upserts.length > 0) {
            const upsertEntities = [...new Set(upserts.map(u => u.entity).filter(Boolean))];
            steps.push({
                step_number: stepNum++,
                title: 'Upsert: Staging → Warehouse',
                description: `For each entity (${this.formatList(upsertEntities)}): delete matching records from the warehouse table by primary key, then insert all records from staging. This ensures the warehouse always reflects the latest version of every record.`,
                input: 'Staging tables (Redshift)',
                output: 'Updated warehouse tables (Redshift)',
            });
        }

        // Fallback: if no entity-level steps were generated
        if (steps.length === 0) {
            if (allInputs.length > 0) {
                const inputNames = [...new Set(allInputs.map(i => i.source || i.type))].slice(0, 5);
                steps.push({
                    step_number: stepNum++,
                    title: 'Data Collection',
                    description: `Read data from ${inputNames.length} source(s): ${this.formatList(inputNames)}`,
                    input: 'Raw data sources',
                    output: 'Data loaded into the system',
                });
            }

            if (allTransforms.length > 0) {
                const grouped = this.groupTransforms(allTransforms);
                for (const [type, transforms] of Object.entries(grouped)) {
                    steps.push({
                        step_number: stepNum++,
                        title: this.friendlyTransformName(type),
                        description: transforms[0].description || `${this.friendlyTransformName(type)} on the data`,
                        input: 'Data from previous step',
                        output: 'Processed data',
                    });
                }
            }

            if (allOutputs.length > 0) {
                const outputNames = [...new Set(allOutputs.map(o => o.target || o.type))].slice(0, 5);
                steps.push({
                    step_number: stepNum++,
                    title: 'Save Results',
                    description: `Write processed data to ${this.formatList(outputNames)}`,
                    input: 'Processed data',
                    output: outputNames.join(', '),
                });
            }
        }

        return steps;
    }

    buildTransformationList(allTransforms, parsedOutputs, entities) {
        const transformations = [];
        const seen = new Set();

        // Use function_scopes for entity-accurate attribution
        for (const parsed of parsedOutputs) {
            const file = parsed.file;
            const scopes = parsed.function_scopes || {};

            if (Object.keys(scopes).length > 0) {
                for (const [funcName, scope] of Object.entries(scopes)) {
                    // Figure out which entity this function processes
                    const scopeEntities = [...new Set([
                        ...(scope.inputs || []).map(i => i.entity || this.inferEntity(i.source || i.type)),
                        ...(scope.outputs || []).map(o => o.entity || this.inferEntity(o.target || o.type)),
                    ])].filter(Boolean);
                    const entity = scopeEntities[0] || funcName;

                    for (const t of (scope.transforms || []).slice(0, 8)) {
                        const key = `${t.type}-${entity}`;
                        if (seen.has(key)) continue;
                        seen.add(key);

                        transformations.push({
                            name: this.friendlyTransformName(t.type),
                            description: t.description || `Performs ${t.type} on the data`,
                            input_data: `${entity} data`,
                            output_data: `Transformed ${entity} data`,
                            entity: entity,
                            source_file: file,
                        });
                    }
                }
            } else {
                // Fallback: file-level entity inference
                const entity = this.inferEntityFromFile(file, entities);
                for (const t of (parsed.transformations || []).slice(0, 8)) {
                    const key = `${t.type}-${entity || file}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    transformations.push({
                        name: this.friendlyTransformName(t.type),
                        description: t.description || `Performs ${t.type} on the data`,
                        input_data: entity ? `${entity} data` : 'Source data',
                        output_data: entity ? `Transformed ${entity} data` : 'Transformed data',
                        entity: entity || '',
                        source_file: file,
                    });
                }
            }
        }

        return transformations.slice(0, 40);
    }

    inferDedupKey(entity) {
        const keyMap = {
            author: 'author_id', authors: 'author_id',
            book: 'book_id', books: 'book_id',
            review: 'review_id', reviews: 'review_id',
            user: 'user_id', users: 'user_id',
        };
        return keyMap[entity?.toLowerCase()] || `${entity}_id`;
    }

    inferEntity(name) {
        if (!name) return null;
        const lower = name.toLowerCase();
        const parts = lower.replace(/\\/g, '/').split('/').filter(Boolean);
        for (const part of parts.reverse()) {
            const clean = part.replace(/\.\w+$/, '').replace(/[-_]/g, '');
            if (clean.length > 1 &&
                !['s3', 'abfss', 'zone', 'bucket', 'staging', 'warehouse', 'processed', 'working', 'landing', 'raw', 'bronze', 'silver', 'gold'].includes(clean)) {
                return part.replace(/\.\w+$/, '');
            }
        }
        return null;
    }

    inferEntityFromFile(file, entities) {
        const lower = (file || '').toLowerCase();
        for (const [entity] of entities) {
            if (lower.includes(entity.toLowerCase().replace(/s$/, ''))) return entity;
        }
        return null;
    }

    capitalize(str) {
        return (str || '').replace(/\b\w/g, c => c.toUpperCase());
    }

    friendlyTransformName(type) {
        const nameMap = {
            merge: 'Combining Datasets', join: 'Joining Datasets', filter: 'Filtering Records',
            groupby: 'Grouping Data', aggregate: 'Calculating Summaries', sort: 'Sorting Records',
            drop: 'Removing Unnecessary Data', rename: 'Renaming Fields', select: 'Selecting Columns',
            fill_missing: 'Filling Missing Values', drop_missing: 'Removing Incomplete Records',
            deduplicate: 'Removing Duplicates', repartition: 'Redistributing Data',
            cache: 'Caching Data', broadcast: 'Broadcasting Dataset',
            apply: 'Custom Processing', map: 'Mapping Values', pivot: 'Pivoting Data',
            type_cast: 'Converting Data Types', conditional: 'Applying Business Rules',
            ranking: 'Ranking Records', add_column: 'Adding Columns',
            string_split: 'Splitting Strings', window: 'Window Functions',
            union: 'Combining Datasets', update: 'Updating Records',
        };
        return nameMap[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    groupTransforms(transforms) {
        const groups = {};
        for (const t of transforms) {
            if (!groups[t.type]) groups[t.type] = [];
            groups[t.type].push(t);
        }
        return groups;
    }

    formatList(items) {
        if (items.length === 0) return '';
        if (items.length === 1) return items[0];
        if (items.length === 2) return `${items[0]} and ${items[1]}`;
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
    }
}
