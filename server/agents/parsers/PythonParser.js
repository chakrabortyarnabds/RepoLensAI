import fs from 'fs/promises';

export class PythonParser {
    constructor() {
        this.name = 'PythonParser';
    }

    async parseFile(filePath, relativePath) {
        const rawContent = await fs.readFile(filePath, 'utf-8');

        const result = {
            file: relativePath,
            language: 'python',
            inputs: [],
            outputs: [],
            transformations: [],
            intermediate_steps: [],
            dependencies: [],
            functions: [],
            classes: [],
            columns: {},
            config_vars: {},  // track config variable assignments
        };

        // PRE-PROCESS: join backslash-continued lines
        const joinedContent = this.joinContinuationLines(rawContent);
        const logicalLines = joinedContent.split('\n');

        // --- FUNCTION SCOPE TRACKING ---
        // Detect function boundaries so we can tag inputs/outputs/transforms
        // with their enclosing function. This enables entity-accurate edge routing.
        let currentFunction = null;

        for (let i = 0; i < logicalLines.length; i++) {
            const line = logicalLines[i].trim();
            const rawLine = logicalLines[i]; // keep original indentation
            const lineNum = i + 1;

            // Detect function boundaries (def at class-member or module level)
            const funcMatch = rawLine.match(/^(\s*)def\s+(\w+)\s*\((.*?)\)/);
            if (funcMatch) {
                currentFunction = funcMatch[2];
            }

            // Track the input/output/transform count BEFORE parsing this line
            const inputsBefore = result.inputs.length;
            const outputsBefore = result.outputs.length;
            const transformsBefore = result.transformations.length;

            this.parseImports(line, result);
            this.parseConfigVars(line, result);
            this.parseInputs(line, lineNum, result);
            this.parseOutputs(line, lineNum, result);
            this.parseTransformations(line, lineNum, result);
            this.parseFunctions(line, lineNum, result);
            this.parseClasses(line, lineNum, result);
            this.parseColumns(line, lineNum, result);
            this.parseDLTDecorators(line, lineNum, result);

            // Stamp newly-added items with their enclosing function scope
            if (currentFunction) {
                for (let j = inputsBefore; j < result.inputs.length; j++) {
                    result.inputs[j].scope = currentFunction;
                }
                for (let j = outputsBefore; j < result.outputs.length; j++) {
                    result.outputs[j].scope = currentFunction;
                }
                for (let j = transformsBefore; j < result.transformations.length; j++) {
                    result.transformations[j].scope = currentFunction;
                }
            }
        }

        // Full-content patterns
        this.parseEmbeddedSQL(joinedContent, result);
        this.parseMultiLinePatterns(joinedContent, result);

        // --- Build function_scopes map ---
        // Groups inputs, outputs, transforms by their enclosing function.
        // The LineageAgent uses this to create entity-accurate edges.
        const scopeMap = new Map();
        for (const inp of result.inputs) {
            if (!inp.scope) continue;
            if (!scopeMap.has(inp.scope)) scopeMap.set(inp.scope, { inputs: [], outputs: [], transforms: [] });
            scopeMap.get(inp.scope).inputs.push(inp);
        }
        for (const out of result.outputs) {
            if (!out.scope) continue;
            if (!scopeMap.has(out.scope)) scopeMap.set(out.scope, { inputs: [], outputs: [], transforms: [] });
            scopeMap.get(out.scope).outputs.push(out);
        }
        for (const t of result.transformations) {
            if (!t.scope) continue;
            if (!scopeMap.has(t.scope)) scopeMap.set(t.scope, { inputs: [], outputs: [], transforms: [] });
            scopeMap.get(t.scope).transforms.push(t);
        }
        result.function_scopes = Object.fromEntries(scopeMap);

        // Deduplicate
        result.inputs = this.deduplicateBySource(result.inputs);
        result.outputs = this.deduplicateByTarget(result.outputs);
        result.dependencies = [...new Set(result.dependencies)];

        return result;
    }

    joinContinuationLines(content) {
        const rawLines = content.split('\n');
        const joined = [];
        let buffer = '';
        for (const line of rawLines) {
            const trimmed = line.trimEnd();
            if (trimmed.endsWith('\\')) {
                buffer += trimmed.slice(0, -1).trim() + ' ';
            } else {
                buffer += line;
                joined.push(buffer);
                buffer = '';
            }
        }
        if (buffer) joined.push(buffer);
        return joined.join('\n');
    }

    deduplicateBySource(arr) {
        const seen = new Set();
        return arr.filter(item => {
            const key = `${item.source}|${item.type}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    deduplicateByTarget(arr) {
        const seen = new Set();
        return arr.filter(item => {
            const key = `${item.target}|${item.type}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    parseImports(line, result) {
        const importMatch = line.match(/^(?:from\s+([\w.]+)\s+)?import\s+(.+)/);
        if (importMatch) {
            const module = importMatch[1] || importMatch[2].split(',')[0].trim().split(' ')[0];
            if (!result.dependencies.includes(module)) {
                result.dependencies.push(module);
            }
        }
    }

    /**
     * Track config variable assignments like:
     *   self._load_path = 's3a://' + config.get('BUCKET', 'WORKING_ZONE')
     *   s3_processed_zone = 's3://' + config.get('BUCKET', 'PROCESSED_ZONE')
     */
    parseConfigVars(line, result) {
        // self._var = 's3a://' + config.get(...)
        const selfVarMatch = line.match(/self\.(_\w+)\s*=\s*['"](s3[a]?:\/\/)['"]\s*\+\s*config\.get\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]\s*\)/);
        if (selfVarMatch) {
            result.config_vars[selfVarMatch[1]] = {
                prefix: selfVarMatch[2],
                zone: selfVarMatch[3].toLowerCase().replace(/_/g, ' '),
                original: line.trim(),
            };
        }

        // var = 's3://' + config.get(...)
        const varMatch = line.match(/(\w+)\s*=\s*['"](s3[a]?:\/\/)['"]\s*\+\s*config\.get\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]\s*\)/);
        if (varMatch) {
            result.config_vars[varMatch[1]] = {
                prefix: varMatch[2],
                zone: varMatch[3].toLowerCase().replace(/_/g, ' '),
                original: line.trim(),
            };
        }
    }

    parseInputs(line, lineNum, result) {
        // --- SPARK READSTREAM with .load() ---
        const readStreamMatch = line.match(/\.readStream.*\.load\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (readStreamMatch) {
            const path = readStreamMatch[1];
            const fmtMatch = line.match(/\.format\s*\(\s*['"](.*?)['"]/);
            result.inputs.push({
                type: 'spark_stream_read',
                source: this.extractTableName(path),
                path: this.cleanPath(path),
                line: lineNum,
                framework: 'spark_streaming',
                format: fmtMatch ? (fmtMatch[1] === 'cloudFiles' ? 'AutoLoader' : fmtMatch[1]) : 'stream',
            });
            return;
        }

        // --- CONCATENATED PATH READ: self._load_path + '/author.csv' or similar ---
        const concatReadMatch = line.match(/\.read\s*(?:\.\s*\w+\s*\(.*?\)\s*)*\.?\s*(?:csv|parquet|json|format)\s*\(\s*(?:path\s*=\s*)?(?:self\.)?([\w_]+)\s*\+\s*['"](.*?)['"]/);
        if (concatReadMatch) {
            const varName = concatReadMatch[1];
            const pathSuffix = concatReadMatch[2];
            const resolvedZone = result.config_vars[varName]?.zone || varName;
            const tableName = this.extractEntityFromPath(pathSuffix);
            const fmtMatch = line.match(/\.read\.(csv|parquet|json|orc|avro)/i) || line.match(/\.format\s*\(\s*['"](.*?)['"]/);
            const format = fmtMatch ? fmtMatch[1].toUpperCase() : 'CSV';

            result.inputs.push({
                type: 'spark_read',
                source: `${resolvedZone}/${tableName}`,
                path: `s3://${resolvedZone}${pathSuffix}`,
                line: lineNum,
                framework: 'spark',
                format,
                zone: resolvedZone,
                entity: tableName,
            });
            return;
        }

        // --- SPARK READ with .format().load() ---
        const sparkFormatLoad = line.match(/\.read\s*\..*format\s*\(\s*['"](.*?)['"].*\.load\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (sparkFormatLoad) {
            result.inputs.push({
                type: `spark_read_${sparkFormatLoad[1]}`,
                source: this.extractTableName(sparkFormatLoad[2]),
                path: this.cleanPath(sparkFormatLoad[2]),
                line: lineNum,
                framework: 'spark',
                format: sparkFormatLoad[1] === 'delta' ? 'Delta' : sparkFormatLoad[1].toUpperCase(),
            });
            return;
        }

        // --- SPARK READ direct: .read.csv("path") ---
        const sparkReadDirect = line.match(/\.read\s*\.(csv|parquet|json|orc|text|avro)\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (sparkReadDirect) {
            result.inputs.push({
                type: `spark_read_${sparkReadDirect[1]}`,
                source: this.extractTableName(sparkReadDirect[2]),
                path: this.cleanPath(sparkReadDirect[2]),
                line: lineNum,
                framework: 'spark',
                format: sparkReadDirect[1].toUpperCase(),
            });
            return;
        }

        // --- SPARK READ with keyword arg: .read.csv(path = ...) ---
        // Note: this catches self._spark.read.csv( self._load_path + '/author.csv', ...) already handled above
        // But also: .read.csv(path = 'some_path', ...)
        const kwArgRead = line.match(/\.read\.(csv|parquet|json|orc)\s*\(.*?(?:path\s*=\s*)?(?:f)?['"]([\w:/.\-_{}]+)['"]/);
        if (kwArgRead && !concatReadMatch) {
            result.inputs.push({
                type: `spark_read_${kwArgRead[1]}`,
                source: this.extractTableName(kwArgRead[2]),
                path: this.cleanPath(kwArgRead[2]),
                line: lineNum,
                framework: 'spark',
                format: kwArgRead[1].toUpperCase(),
            });
        }

        // --- spark.table("name") ---
        const sparkTable = line.match(/spark\.table\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (sparkTable) {
            result.inputs.push({
                type: 'spark_table_read', source: sparkTable[1],
                line: lineNum, framework: 'spark', format: 'Delta Table',
            });
        }

        // --- DeltaTable.forPath/forName ---
        const deltaTable = line.match(/DeltaTable\.for(Path|Name)\s*\(\s*\w+\s*,\s*(?:f)?['"](.*?)['"]/);
        if (deltaTable) {
            result.inputs.push({
                type: 'delta_table_read', source: this.extractTableName(deltaTable[2]),
                path: this.cleanPath(deltaTable[2]),
                line: lineNum, framework: 'delta', format: 'Delta',
            });
        }

        // --- spark.sql("SELECT ... FROM table") ---
        const sparkSql = line.match(/spark\.sql\s*\(\s*(?:f)?['"]{1,3}(.*?)['"]{1,3}\s*\)/s);
        if (sparkSql) {
            const sql = sparkSql[1];
            const fromTables = sql.match(/FROM\s+([\w.`"]+)/gi);
            if (fromTables) {
                for (const match of fromTables) {
                    const tbl = match.replace(/FROM\s+/i, '').replace(/[`"]/g, '').trim();
                    if (tbl.length > 1 && !tbl.startsWith('(')) {
                        result.inputs.push({
                            type: 'spark_sql_read', source: tbl,
                            line: lineNum, framework: 'spark', format: 'SQL',
                        });
                    }
                }
            }
        }

        // --- pandas read ---
        const pandasRead = line.match(/pd\.read_(csv|json|excel|parquet|sql|table)\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (pandasRead) {
            result.inputs.push({
                type: `read_${pandasRead[1]}`, source: this.extractTableName(pandasRead[2]),
                path: pandasRead[2], line: lineNum, framework: 'pandas', format: pandasRead[1].toUpperCase(),
            });
        }

        // --- open() for reading ---
        const openRead = line.match(/open\s*\(\s*(?:f)?['"](.*?)['"].*?['"]r/);
        if (openRead) {
            result.inputs.push({
                type: 'file_read', source: this.extractTableName(openRead[1]),
                path: openRead[1], line: lineNum, framework: 'builtin', format: 'File',
            });
        }

        // --- requests / API calls ---
        const apiCall = line.match(/requests\.(get|post|put|delete)\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (apiCall) {
            result.inputs.push({
                type: `api_${apiCall[1]}`, source: apiCall[2],
                line: lineNum, framework: 'requests', format: 'API',
            });
        }
    }

    parseOutputs(line, lineNum, result) {
        // --- SPARK WRITESTREAM .start("path") ---
        const writeStreamStart = line.match(/\.writeStream.*\.start\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (writeStreamStart) {
            result.outputs.push({
                type: 'spark_stream_write', target: this.extractTableName(writeStreamStart[1]),
                path: this.cleanPath(writeStreamStart[1]),
                line: lineNum, framework: 'spark_streaming', format: 'Stream',
            });
            return;
        }

        // --- CONCATENATED PATH WRITE: .write.csv(path = self._save_path + '/authors/') ---
        const concatWriteMatch = line.match(/\.write\s*(?:\.\s*\w+\s*\(.*?\)\s*)*\.?\s*(?:csv|parquet|json|format)\s*\(\s*(?:path\s*=\s*)?(?:self\.)?([\w_]+)\s*\+\s*['"]([^'"]+)['"]/);
        if (concatWriteMatch) {
            const varName = concatWriteMatch[1];
            const pathSuffix = concatWriteMatch[2];
            const resolvedZone = result.config_vars[varName]?.zone || varName;
            const tableName = this.extractEntityFromPath(pathSuffix);
            const fmtMatch = line.match(/\.write\.(csv|parquet|json|orc|avro)/i) || line.match(/\.format\s*\(\s*['"](.*?)['"]/);
            const format = fmtMatch ? fmtMatch[1].toUpperCase() : 'CSV';

            result.outputs.push({
                type: 'spark_write', target: `${resolvedZone}/${tableName}`,
                path: `s3://${resolvedZone}${pathSuffix}`,
                line: lineNum, framework: 'spark', format,
                zone: resolvedZone, entity: tableName,
            });
            return;
        }

        // --- .write.format().option("path", ...).save() ---
        const sparkFormatSaveWithPath = line.match(/\.write\s*\..*format\s*\(\s*['"](.*?)['"].*\.save\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (sparkFormatSaveWithPath) {
            result.outputs.push({
                type: 'spark_write', target: this.extractTableName(sparkFormatSaveWithPath[2]),
                path: this.cleanPath(sparkFormatSaveWithPath[2]),
                line: lineNum, framework: 'spark',
                format: sparkFormatSaveWithPath[1] === 'delta' ? 'Delta' : sparkFormatSaveWithPath[1].toUpperCase(),
            });
            return;
        }

        // --- .write.format("delta").option("path", "abfss://...").save() ---
        const sparkOptionPath = line.match(/\.write\s*\..*\.option\s*\(\s*['"]path['"].*?['"]((?:abfss?|s3[a]?):\/\/.*?)['"]/);
        if (sparkOptionPath) {
            const fmtMatch = line.match(/\.format\s*\(\s*['"](.*?)['"]/);
            result.outputs.push({
                type: 'spark_write', target: this.extractTableName(sparkOptionPath[1]),
                path: this.cleanPath(sparkOptionPath[1]),
                line: lineNum, framework: 'spark',
                format: fmtMatch ? (fmtMatch[1] === 'delta' ? 'Delta' : fmtMatch[1].toUpperCase()) : 'Delta',
            });
            return;
        }

        // --- .saveAsTable("table_name") ---
        const saveAsTable = line.match(/\.saveAsTable\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (saveAsTable) {
            result.outputs.push({
                type: 'spark_write_table', target: saveAsTable[1],
                line: lineNum, framework: 'spark', format: 'Delta Table',
            });
        }

        // --- .write.csv/parquet/json("path") (direct string path) ---
        const sparkWriteDirect = line.match(/\.write\s*\.(csv|parquet|json|orc|text)\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (sparkWriteDirect && !concatWriteMatch) {
            result.outputs.push({
                type: `spark_write_${sparkWriteDirect[1]}`, target: this.extractTableName(sparkWriteDirect[2]),
                path: this.cleanPath(sparkWriteDirect[2]),
                line: lineNum, framework: 'spark', format: sparkWriteDirect[1].toUpperCase(),
            });
        }

        // --- pandas write ---
        const pandasWrite = line.match(/\.to_(csv|json|excel|parquet|sql|html)\s*\(\s*(?:f)?['"](.*?)['"]/);
        if (pandasWrite) {
            result.outputs.push({
                type: `write_${pandasWrite[1]}`, target: this.extractTableName(pandasWrite[2]),
                path: pandasWrite[2], line: lineNum, framework: 'pandas', format: pandasWrite[1].toUpperCase(),
            });
        }

        // --- open() for writing ---
        const openWrite = line.match(/open\s*\(\s*(?:f)?['"](.*?)['"].*?['"]w/);
        if (openWrite) {
            result.outputs.push({
                type: 'file_write', target: this.extractTableName(openWrite[1]),
                path: openWrite[1], line: lineNum, framework: 'builtin', format: 'File',
            });
        }
    }

    /**
     * Extract SQL from triple-quoted strings in Python files.
     * Handles CREATE TABLE, COPY, INSERT INTO, UPSERT patterns.
     */
    parseEmbeddedSQL(content, result) {
        // Find all triple-quoted strings
        const tripleQuoteBlocks = content.matchAll(/"""([\s\S]*?)"""/g);
        for (const [, block] of tripleQuoteBlocks) {
            const sql = block.trim();

            // CREATE TABLE with columns
            const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:\{[^{}]*\})\.)?(?:(?:\{[^{}]*\})\.)?(\w+)\s*\(([\s\S]*?)\)/i);
            if (createMatch) {
                const schemaPlaceholder = '';
                const tableName = createMatch[1];
                const columnsBlock = createMatch[2];

                // Extract columns from DDL
                const columns = this.extractColumnsFromDDL(columnsBlock);
                if (columns.length > 0) {
                    if (!result.columns._schemas) result.columns._schemas = {};
                    result.columns._schemas[tableName] = columns;
                }

                result.outputs.push({
                    type: 'sql_ddl_create', target: tableName,
                    line: 0, framework: 'sql', format: 'SQL DDL',
                    columns,
                    schema_ref: schemaPlaceholder,
                });
            }

            // COPY table FROM 's3://path'
            const copyMatch = sql.match(/COPY\s+(?:(?:\{[^{}]*\})\.)?(\w+)\s+FROM\s+'((?:\{[^{}]*\})\/\w+|[^']+)'/i);
            if (copyMatch) {
                const tableName = copyMatch[1];
                const sourcePath = copyMatch[2];
                const entity = this.extractEntityFromPath('/' + tableName);

                result.inputs.push({
                    type: 'redshift_copy', source: `processed zone/${entity}`,
                    path: sourcePath,
                    line: 0, framework: 'redshift', format: 'COPY (S3→Redshift)',
                    entity,
                });

                result.outputs.push({
                    type: 'redshift_staging_load', target: `staging/${tableName}`,
                    line: 0, framework: 'redshift', format: 'Staging Table',
                    entity,
                });
            }

            // INSERT INTO warehouse.table SELECT * FROM staging.table (UPSERT)
            const insertMatch = sql.match(/INSERT\s+INTO\s+(?:(?:\{[^{}]*\})\.)?(\w+)\s+SELECT\s+\*\s+FROM\s+(?:(?:\{[^{}]*\})\.)?(\w+)/i);
            if (insertMatch) {
                const targetTable = insertMatch[1];
                const sourceTable = insertMatch[2];

                result.intermediate_steps.push({
                    type: 'upsert',
                    description: `Upsert: staging/${sourceTable} → warehouse/${targetTable}`,
                    source: `staging/${sourceTable}`,
                    target: `warehouse/${targetTable}`,
                    entity: this.extractEntityFromPath('/' + targetTable),
                });
            }

            // DELETE FROM warehouse USING staging (part of upsert)
            const deleteMatch = sql.match(/DELETE\s+FROM\s+(?:(?:\{[^{}]*\})\.)?(\w+)\s+using\s+(?:(?:\{[^{}]*\})\.)?(\w+)/i);
            if (deleteMatch) {
                result.intermediate_steps.push({
                    type: 'upsert_delete',
                    description: `Delete matching records from warehouse/${deleteMatch[1]} using staging/${deleteMatch[2]}`,
                    entity: this.extractEntityFromPath('/' + deleteMatch[1]),
                });
            }
        }

        // Also handle Databricks magic SQL: # MAGIC %sql
        const magicSqlBlocks = content.matchAll(/# MAGIC %sql\s*\n((?:# MAGIC .*\n)*)/g);
        for (const [, block] of magicSqlBlocks) {
            const sql = block.replace(/# MAGIC\s*/g, '').trim();
            const createMatch = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/i);
            if (createMatch) {
                result.outputs.push({
                    type: 'sql_create', target: createMatch[1],
                    line: 0, framework: 'sql', format: 'SQL DDL',
                });
            }
        }
    }

    /**
     * Extract column definitions from SQL DDL.
     */
    extractColumnsFromDDL(columnsBlock) {
        const columns = [];
        const lines = columnsBlock.split('\n');
        for (const line of lines) {
            const trimmed = line.trim().replace(/,$/, '');
            if (!trimmed || trimmed.startsWith('--')) continue;

            // Skip constraint lines
            if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|DISTSTYLE|DISTKEY|SORTKEY)/i.test(trimmed)) continue;

            const colMatch = trimmed.match(/^["`]?(\w+)["`]?\s+([\w()]+)/);
            if (colMatch) {
                columns.push({
                    name: colMatch[1],
                    dataType: colMatch[2].replace(/\(.*\)/, ''),
                });
            }
        }
        return columns;
    }

    parseTransformations(line, lineNum, result) {
        const dfOps = [
            { pattern: /\.merge\s*\(/, type: 'merge', desc: 'Combining datasets based on common columns' },
            { pattern: /\.join\s*\(/, type: 'join', desc: 'Joining datasets together' },
            { pattern: /\.groupBy\s*\(/i, type: 'groupby', desc: 'Grouping data by categories' },
            { pattern: /\.groupby\s*\(/i, type: 'groupby', desc: 'Grouping data by categories' },
            { pattern: /\.agg\s*\(/, type: 'aggregate', desc: 'Calculating summary statistics' },
            { pattern: /\.filter\s*\(/, type: 'filter', desc: 'Filtering data based on conditions' },
            { pattern: /\.where\s*\(/, type: 'filter', desc: 'Filtering data based on conditions' },
            { pattern: /\.drop\s*\(/, type: 'drop', desc: 'Removing columns or rows' },
            { pattern: /\.withColumnRenamed\s*\(/, type: 'rename', desc: 'Renaming columns' },
            { pattern: /\.withColumn\s*\(/, type: 'add_column', desc: 'Adding or transforming a column' },
            { pattern: /\.select\s*\(/, type: 'select', desc: 'Selecting specific columns' },
            { pattern: /\.sort\s*\(/, type: 'sort', desc: 'Sorting data' },
            { pattern: /\.orderBy\s*\(/, type: 'sort', desc: 'Sorting data by specific order' },
            { pattern: /\.fillna\s*\(/, type: 'fill_missing', desc: 'Filling missing values' },
            { pattern: /\.dropna\s*\(/, type: 'drop_missing', desc: 'Removing missing values' },
            { pattern: /\.dropDuplicates\s*\(/, type: 'deduplicate', desc: 'Removing duplicate records' },
            { pattern: /\.distinct\s*\(/, type: 'deduplicate', desc: 'Keeping only unique records' },
            { pattern: /\.repartition\s*\(/, type: 'repartition', desc: 'Redistributing data across partitions' },
            { pattern: /\.persist\s*\(/, type: 'cache', desc: 'Caching data in memory for performance' },
            { pattern: /fn\.broadcast\s*\(/, type: 'broadcast', desc: 'Broadcasting smaller dataset for efficient join' },
            { pattern: /\.apply\s*\(/, type: 'apply', desc: 'Applying custom transformation' },
            { pattern: /\.map\s*\(/, type: 'map', desc: 'Mapping values' },
            { pattern: /\.pivot\s*\(/, type: 'pivot', desc: 'Creating pivot table' },
            { pattern: /\.union\s*\(/, type: 'union', desc: 'Combining multiple datasets' },
            { pattern: /\.cast\s*\(/, type: 'type_cast', desc: 'Converting data types' },
            { pattern: /\.astype\s*\(/, type: 'type_cast', desc: 'Converting data types' },
            { pattern: /dense_rank\s*\(/, type: 'ranking', desc: 'Ranking records' },
            { pattern: /when\s*\(\s*col/, type: 'conditional', desc: 'Conditional logic (CASE/WHEN)' },
            { pattern: /split\s*\(/, type: 'string_split', desc: 'Splitting string values' },
            { pattern: /fn\.max\s*\(/, type: 'aggregate', desc: 'Finding maximum values' },
            { pattern: /fn\.min\s*\(/, type: 'aggregate', desc: 'Finding minimum values' },
            { pattern: /fn\.count\s*\(/, type: 'aggregate', desc: 'Counting records' },
            { pattern: /fn\.sum\s*\(/, type: 'aggregate', desc: 'Summing values' },
        ];

        for (const op of dfOps) {
            if (op.pattern.test(line)) {
                result.transformations.push({
                    type: op.type,
                    description: op.desc,
                    line: lineNum,
                });
            }
        }
    }

    parseColumns(line, lineNum, result) {
        // .withColumn("col_name", ...)
        const withCol = line.match(/\.withColumn\s*\(\s*['"](.*?)['"]/);
        if (withCol) {
            if (!result.columns._detected) result.columns._detected = [];
            result.columns._detected.push({ name: withCol[1], line: lineNum });
        }

        // .withColumnRenamed("old", "new")
        const renameCol = line.match(/\.withColumnRenamed\s*\(\s*['"](.*?)['"]\s*,\s*['"](.*?)['"]/);
        if (renameCol) {
            if (!result.columns._detected) result.columns._detected = [];
            result.columns._detected.push({ name: renameCol[2], line: lineNum, renamedFrom: renameCol[1] });
        }

        // StructField("name", TypeType())
        const structField = line.match(/StructField\s*\(\s*['"](.*?)['"]\s*,\s*(\w+)\s*\(/);
        if (structField) {
            if (!result.columns._detected) result.columns._detected = [];
            result.columns._detected.push({ name: structField[1], dataType: structField[2], line: lineNum });
        }

        // .select(df.columns) or .select("col1", "col2")
        const selectCols = line.match(/\.select\s*\(\s*(.+)\s*\)/);
        if (selectCols) {
            const cols = selectCols[1].matchAll(/['"]([\w*]+)['"]/g);
            for (const c of cols) {
                if (!result.columns._detected) result.columns._detected = [];
                result.columns._detected.push({ name: c[1], line: lineNum });
            }
        }

        // .fillna({'col1': val, 'col2': val})
        const fillnaCols = line.match(/\.fillna\s*\(\s*\{(.+?)\}\s*\)/);
        if (fillnaCols) {
            const entries = fillnaCols[1].matchAll(/['"]([\w]+)['"]/g);
            for (const e of entries) {
                if (!result.columns._detected) result.columns._detected = [];
                const existing = result.columns._detected.find(c => c.name === e[1]);
                if (!existing) result.columns._detected.push({ name: e[1], line: lineNum });
            }
        }
    }

    parseDLTDecorators(line, lineNum, result) {
        const dltTable = line.match(/@dlt\.table\s*\(\s*.*?name\s*=\s*['"](.*?)['"]/);
        if (dltTable) {
            result.outputs.push({
                type: 'dlt_table', target: dltTable[1],
                line: lineNum, framework: 'delta_live_tables', format: 'DLT',
            });
        }
    }

    parseMultiLinePatterns(content, result) {
        // Detect variable assignments with ABFSS paths
        const pathAssignments = content.matchAll(/(\w+)\s*=\s*(?:f)?['"](abfss?:\/\/.*?)['"]/g);
        for (const [, varName, path] of pathAssignments) {
            if (content.includes(`.load(${varName})`) || content.includes(`.load( ${varName})`)) {
                result.inputs.push({
                    type: 'spark_read', source: this.extractTableName(path),
                    path: this.cleanPath(path),
                    line: 0, framework: 'spark', format: 'Cloud Storage',
                });
            }
        }

        // Detect S3 bucket operations: s3_move_data(source_bucket=..., target_bucket=...)
        const s3MoveMatch = content.match(/s3_move_data\s*\(\s*source_bucket\s*=\s*config\.get\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]\)\s*,\s*target_bucket\s*=\s*config\.get\(\s*['"]\w+['"]\s*,\s*['"](\w+)['"]\)/);
        if (s3MoveMatch) {
            const sourceZone = s3MoveMatch[1].toLowerCase().replace(/_/g, ' ');
            const targetZone = s3MoveMatch[2].toLowerCase().replace(/_/g, ' ');
            result.intermediate_steps.push({
                type: 's3_data_movement',
                description: `Move data from ${sourceZone} to ${targetZone}`,
                source: sourceZone,
                target: targetZone,
            });
        }

        // Detect warehouse driver calls
        const warehouseOps = [
            { pattern: /setup_staging_tables\s*\(\)/, desc: 'Set up staging tables in data warehouse' },
            { pattern: /load_staging_tables\s*\(\)/, desc: 'Load data into staging tables from processed zone' },
            { pattern: /setup_warehouse_tables\s*\(\)/, desc: 'Set up data warehouse tables' },
            { pattern: /perform_upsert\s*\(\)/, desc: 'Upsert data from staging into warehouse tables' },
        ];
        for (const op of warehouseOps) {
            if (op.pattern.test(content)) {
                result.intermediate_steps.push({
                    type: 'warehouse_operation',
                    description: op.desc,
                });
            }
        }
    }

    extractTableName(pathOrName) {
        if (!pathOrName) return 'unknown';

        // ABFSS paths
        const abfssMatch = pathOrName.match(/abfss?:\/\/(\w+)@[\w.]+\/(.*)/);
        if (abfssMatch) {
            const container = abfssMatch[1];
            const subpath = abfssMatch[2]?.replace(/\{.*?\}/g, '*') || '';
            return subpath ? `${container}/${subpath}` : container;
        }

        // S3 paths
        const s3Match = pathOrName.match(/s3[an]?:\/\/([\w-]+)\/(.*)/);
        if (s3Match) {
            const bucket = s3Match[1];
            const key = s3Match[2]?.split('/').pop() || '';
            return key ? `${bucket}/${key}` : bucket;
        }

        // No slashes = already a name
        if (!pathOrName.includes('/') && !pathOrName.includes('\\')) return pathOrName;

        // Local paths
        const parts = pathOrName.replace(/\\/g, '/').split('/').filter(Boolean);
        const meaningful = parts.filter(p =>
            !['mnt', 'dbfs', 'tmp', 'home', 'FileStore'].includes(p) && !p.includes('@')
        );
        if (meaningful.length >= 2) return meaningful.slice(-2).join('/');
        return meaningful.pop() || parts.pop() || pathOrName;
    }

    /**
     * Extract entity name from a path suffix like '/authors/' or '/author.csv'
     */
    extractEntityFromPath(pathSuffix) {
        const clean = pathSuffix.replace(/^\//, '').replace(/\/$/, '').replace(/\.\w+$/, '');
        return clean || 'unknown';
    }

    cleanPath(path) {
        return path?.replace(/\{.*?\}/g, '*') || path;
    }

    parseFunctions(line, lineNum, result) {
        const funcMatch = line.match(/^def\s+(\w+)\s*\((.*?)\)/);
        if (funcMatch) {
            result.functions.push({ name: funcMatch[1], params: funcMatch[2], line: lineNum });
        }
    }

    parseClasses(line, lineNum, result) {
        const classMatch = line.match(/^class\s+(\w+)\s*(?:\((.*?)\))?/);
        if (classMatch) {
            result.classes.push({ name: classMatch[1], bases: classMatch[2] || '', line: lineNum });
        }
    }
}
