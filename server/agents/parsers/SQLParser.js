import fs from 'fs/promises';

export class SQLParser {
    constructor() {
        this.name = 'SQLParser';
    }

    async parseFile(filePath, relativePath) {
        const content = await fs.readFile(filePath, 'utf-8');

        const result = {
            file: relativePath,
            language: 'sql',
            inputs: [],
            outputs: [],
            transformations: [],
            intermediate_steps: [],
            dependencies: [],
            columns: { _schemas: {}, _detected: [] },
        };

        // Split into statements
        const statements = this.splitStatements(content);

        for (const stmt of statements) {
            this.parseStatement(stmt.text, stmt.lineStart, result);
        }

        return result;
    }

    splitStatements(content) {
        const lines = content.split('\n');
        const statements = [];
        let currentStmt = '';
        let stmtStartLine = 1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Skip comments
            if (line.startsWith('--') || line.length === 0) continue;

            if (currentStmt === '') stmtStartLine = i + 1;
            currentStmt += ' ' + line;

            if (line.endsWith(';')) {
                statements.push({ text: currentStmt.trim(), lineStart: stmtStartLine });
                currentStmt = '';
            }
        }

        if (currentStmt.trim()) {
            statements.push({ text: currentStmt.trim(), lineStart: stmtStartLine });
        }

        return statements;
    }

    parseStatement(sql, lineStart, result) {
        const upper = sql.toUpperCase().trim();

        // CREATE TABLE
        if (upper.startsWith('CREATE')) {
            const tableMatch = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i);
            if (tableMatch) {
                const tableName = this.cleanName(tableMatch[1]);
                result.outputs.push({
                    type: upper.includes('VIEW') ? 'create_view' : 'create_table',
                    target: tableName,
                    line: lineStart,
                });

                // Extract columns from CREATE TABLE
                const colSection = sql.match(/\(([\s\S]*)\)/);
                if (colSection) {
                    const columns = this.extractColumns(colSection[1]);
                    if (columns.length > 0) {
                        result.intermediate_steps.push({
                            type: 'schema_definition',
                            table: tableName,
                            columns,
                            line: lineStart,
                        });
                        result.columns._schemas[tableName] = columns;
                    }
                }

                // If CREATE TABLE AS SELECT, parse the SELECT part
                const asSelect = sql.match(/AS\s+(SELECT[\s\S]+)/i);
                if (asSelect) {
                    this.parseSelectSources(asSelect[1], lineStart, result);
                }
            }
        }

        // INSERT INTO
        if (upper.startsWith('INSERT')) {
            const insertMatch = sql.match(/INSERT\s+(?:INTO\s+)?(\S+)/i);
            if (insertMatch) {
                result.outputs.push({
                    type: 'insert',
                    target: this.cleanName(insertMatch[1]),
                    line: lineStart,
                });
            }
            // Parse SELECT in INSERT...SELECT
            const selectPart = sql.match(/SELECT[\s\S]+/i);
            if (selectPart) {
                this.parseSelectSources(selectPart[0], lineStart, result);
            }
        }

        // SELECT (standalone)
        if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
            this.parseSelectSources(sql, lineStart, result);
        }

        // DROP
        if (upper.startsWith('DROP')) {
            const dropMatch = sql.match(/DROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
            if (dropMatch) {
                result.intermediate_steps.push({
                    type: 'drop',
                    table: this.cleanName(dropMatch[1]),
                    line: lineStart,
                });
            }
        }

        // ALTER
        if (upper.startsWith('ALTER')) {
            result.transformations.push({
                type: 'alter_table',
                description: 'Modifying table structure',
                line: lineStart,
            });
        }

        // UPDATE
        if (upper.startsWith('UPDATE')) {
            const updateMatch = sql.match(/UPDATE\s+(\S+)/i);
            if (updateMatch) {
                result.transformations.push({
                    type: 'update',
                    target: this.cleanName(updateMatch[1]),
                    description: 'Updating existing records',
                    line: lineStart,
                });
            }
        }

        // DELETE
        if (upper.startsWith('DELETE')) {
            const deleteMatch = sql.match(/DELETE\s+FROM\s+(\S+)/i);
            if (deleteMatch) {
                result.transformations.push({
                    type: 'delete',
                    target: this.cleanName(deleteMatch[1]),
                    description: 'Removing records',
                    line: lineStart,
                });
            }
        }
    }

    parseSelectSources(sql, lineStart, result) {
        // Extract FROM tables
        const fromMatches = sql.match(/FROM\s+(\S+)/gi);
        if (fromMatches) {
            for (const match of fromMatches) {
                const table = match.replace(/FROM\s+/i, '').trim();
                const cleanTable = this.cleanName(table);
                if (cleanTable && !cleanTable.startsWith('(') && cleanTable.length > 1) {
                    if (!result.inputs.find((i) => i.source === cleanTable)) {
                        result.inputs.push({
                            type: 'table_read',
                            source: cleanTable,
                            line: lineStart,
                        });
                    }
                }
            }
        }

        // Extract JOINs
        const joinMatches = sql.match(/((?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\s+)?JOIN\s+(\S+)/gi);
        if (joinMatches) {
            for (const match of joinMatches) {
                const parts = match.match(/((?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\s+)?JOIN\s+(\S+)/i);
                if (parts) {
                    const joinType = (parts[1] || 'INNER').trim();
                    const table = this.cleanName(parts[2]);
                    if (table && table.length > 1) {
                        result.inputs.push({
                            type: 'table_read',
                            source: table,
                            line: lineStart,
                        });
                        result.transformations.push({
                            type: 'join',
                            description: `Combining data using ${joinType.toLowerCase()} join with ${table}`,
                            line: lineStart,
                        });
                    }
                }
            }
        }

        // Detect aggregations
        const aggFunctions = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'GROUP_CONCAT', 'STRING_AGG'];
        for (const agg of aggFunctions) {
            if (sql.toUpperCase().includes(`${agg}(`)) {
                result.transformations.push({
                    type: 'aggregation',
                    description: `Calculating ${agg.toLowerCase()} of values`,
                    line: lineStart,
                });
                break; // One aggregation entry per statement is enough
            }
        }

        // GROUP BY
        if (/GROUP\s+BY/i.test(sql)) {
            result.transformations.push({
                type: 'group_by',
                description: 'Grouping data into categories',
                line: lineStart,
            });
        }

        // WHERE clause
        if (/WHERE\s+/i.test(sql)) {
            result.transformations.push({
                type: 'filter',
                description: 'Filtering data based on conditions',
                line: lineStart,
            });
        }

        // ORDER BY
        if (/ORDER\s+BY/i.test(sql)) {
            result.transformations.push({
                type: 'sort',
                description: 'Sorting the results',
                line: lineStart,
            });
        }

        // UNION
        if (/UNION\s+(ALL\s+)?/i.test(sql)) {
            result.transformations.push({
                type: 'union',
                description: 'Combining results from multiple queries',
                line: lineStart,
            });
        }

        // CTEs (WITH clause)
        const cteMatches = sql.match(/WITH\s+(\w+)\s+AS\s*\(/gi);
        if (cteMatches) {
            for (const match of cteMatches) {
                const cteName = match.match(/WITH\s+(\w+)/i);
                if (cteName) {
                    result.intermediate_steps.push({
                        type: 'cte',
                        name: cteName[1],
                        description: `Temporary result set "${cteName[1]}"`,
                        line: lineStart,
                    });
                }
            }
        }

        // CASE WHEN
        if (/CASE\s+WHEN/i.test(sql)) {
            result.transformations.push({
                type: 'conditional',
                description: 'Applying conditional logic to data',
                line: lineStart,
            });
        }

        // Window functions
        if (/OVER\s*\(/i.test(sql)) {
            result.transformations.push({
                type: 'window_function',
                description: 'Performing calculations across related rows',
                line: lineStart,
            });
        }
    }

    extractColumns(colSection) {
        const columns = [];
        const parts = colSection.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            // Skip constraints
            if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX)/i.test(trimmed)) continue;
            const colMatch = trimmed.match(/^(\w+)\s+(\w[\w\s()]*)/);
            if (colMatch) {
                columns.push({
                    name: colMatch[1],
                    type: colMatch[2].trim(),
                });
            }
        }
        return columns;
    }

    cleanName(name) {
        return name.replace(/[`"'\[\]()]/g, '').replace(/;$/, '').trim();
    }
}
