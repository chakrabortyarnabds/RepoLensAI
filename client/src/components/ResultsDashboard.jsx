import { useState } from 'react';
import LineageGraph from './LineageGraph';
import { exportAsMarkdown, exportAsHTML, downloadFile } from '../utils/api';

const TABS = [
    { id: 'summary', label: 'Summary', icon: '📋' },
    { id: 'lineage', label: 'Lineage Graph', icon: '🔗' },
    { id: 'steps', label: 'Pipeline Steps', icon: '📊' },
    { id: 'transforms', label: 'Transformations', icon: '⚡' },
    { id: 'metadata', label: 'Metadata', icon: '🗃️' },
];

export default function ResultsDashboard({ result }) {
    const [activeTab, setActiveTab] = useState('summary');

    if (!result) return null;

    const handleExportMD = () => {
        const md = exportAsMarkdown(result);
        downloadFile(md, 'repolens-report.md', 'text/markdown');
    };

    const handleExportHTML = () => {
        const html = exportAsHTML(result);
        downloadFile(html, 'repolens-report.html', 'text/html');
    };

    const handleExportPDF = () => {
        const html = exportAsHTML(result);
        const printWindow = window.open('', '_blank');
        printWindow.document.write(html);
        printWindow.document.close();
        setTimeout(() => printWindow.print(), 500);
    };

    const getBadgeCount = (tabId) => {
        switch (tabId) {
            case 'steps': return result.steps?.length || 0;
            case 'transforms': return result.transformations?.length || 0;
            case 'metadata': return result.metadata?.datasets?.length || 0;
            case 'lineage': return result.lineage?.nodes?.length || 0;
            default: return null;
        }
    };

    return (
        <div>
            {/* Stats Bar */}
            <div className="stats-bar">
                <div className="stat-item">
                    <div className="stat-item__value">{result.stats?.total_files || 0}</div>
                    <div className="stat-item__label">Files Analyzed</div>
                </div>
                <div className="stat-item">
                    <div className="stat-item__value">{result.stats?.languages?.length || 0}</div>
                    <div className="stat-item__label">Languages</div>
                </div>
                <div className="stat-item">
                    <div className="stat-item__value">{result.stats?.total_nodes || 0}</div>
                    <div className="stat-item__label">Lineage Nodes</div>
                </div>
                <div className="stat-item">
                    <div className="stat-item__value">{result.stats?.total_edges || 0}</div>
                    <div className="stat-item__label">Connections</div>
                </div>
                <div className="stat-item">
                    <div className="stat-item__value">{result.stats?.total_transformations || 0}</div>
                    <div className="stat-item__label">Transformations</div>
                </div>
            </div>

            {/* Export Bar */}
            <div className="export-bar" style={{ marginBottom: 24 }}>
                <button className="export-btn" onClick={handleExportMD}>📝 Export Markdown</button>
                <button className="export-btn" onClick={handleExportHTML}>🌐 Export HTML</button>
                <button className="export-btn" onClick={handleExportPDF}>📄 Export PDF</button>
            </div>

            {/* Tabs */}
            <div className="tabs">
                <div className="tabs__list">
                    {TABS.map((tab) => (
                        <button
                            key={tab.id}
                            className={`tabs__item ${activeTab === tab.id ? 'tabs__item--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.icon} {tab.label}
                            {getBadgeCount(tab.id) !== null && (
                                <span className="tabs__badge">{getBadgeCount(tab.id)}</span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Tab Content */}
            {activeTab === 'summary' && <SummaryPanel result={result} />}
            {activeTab === 'lineage' && <LineagePanel result={result} />}
            {activeTab === 'steps' && <StepsPanel result={result} />}
            {activeTab === 'transforms' && <TransformsPanel result={result} />}
            {activeTab === 'metadata' && <MetadataPanel result={result} />}

            {/* Validation */}
            {result.validation?.issues?.length > 0 && (
                <div className="result-panel" style={{ marginTop: 24 }}>
                    <h3 className="result-panel__title">
                        <span className="result-panel__title-icon" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>⚠️</span>
                        Validation Notes
                    </h3>
                    {result.validation.issues.map((issue, i) => (
                        <div key={i} className={`validation-item validation-item--${issue.severity}`}>
                            <span className="validation-icon">
                                {issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🔵'}
                            </span>
                            <span className="validation-text">{issue.message}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SummaryPanel({ result }) {
    const detailFlow = result.detail_flow || [];

    return (
        <div className="result-panel">
            <h3 className="result-panel__title">
                <span className="result-panel__title-icon" style={{ background: 'rgba(124, 92, 255, 0.15)' }}>📋</span>
                Pipeline Summary
            </h3>
            <div className="summary-text">{result.summary}</div>

            {detailFlow.length > 0 && (
                <div style={{ marginTop: 24 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '1px' }}>
                        🔄 Pipeline Flow
                    </div>
                    <div className="pipeline-flow">
                        {detailFlow.map((step, i) => (
                            <div key={i} className="flow-step">
                                <div className="flow-step__connector">
                                    <div className="flow-step__dot" />
                                    {i < detailFlow.length - 1 && <div className="flow-step__line" />}
                                </div>
                                <div className="flow-step__text">{step}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {result.stats?.languages?.length > 0 && (
                <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Languages Detected
                    </div>
                    <div>
                        {result.stats.languages.map((lang, i) => (
                            <span key={i} className="metadata-tag metadata-tag--format">{lang}</span>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function LineagePanel({ result }) {
    return (
        <div className="result-panel">
            <h3 className="result-panel__title">
                <span className="result-panel__title-icon" style={{ background: 'rgba(59, 130, 246, 0.15)' }}>🔗</span>
                Data Lineage Graph
            </h3>
            <LineageGraph lineage={result.lineage} />
        </div>
    );
}

function StepsPanel({ result }) {
    const steps = result.steps || [];

    if (!steps.length) {
        return (
            <div className="result-panel">
                <div className="empty-state">
                    <div className="empty-state__icon">📊</div>
                    <div className="empty-state__title">No Steps Detected</div>
                    <div className="empty-state__desc">The analyzer did not detect distinct pipeline steps in this repository.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="result-panel">
            <h3 className="result-panel__title">
                <span className="result-panel__title-icon" style={{ background: 'rgba(16, 185, 129, 0.15)' }}>📊</span>
                Pipeline Steps
            </h3>
            <div className="steps-list">
                {steps.map((step, i) => (
                    <div key={i} className="step-card">
                        <div className="step-number">{step.step_number || i + 1}</div>
                        <div className="step-content">
                            <div className="step-content__title">{step.title}</div>
                            <div className="step-content__desc">{step.description}</div>
                            <div className="step-content__io">
                                {step.input && (
                                    <span className="step-io-badge step-io-badge--input">↓ {step.input}</span>
                                )}
                                {step.output && (
                                    <span className="step-io-badge step-io-badge--output">↑ {step.output}</span>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function TransformsPanel({ result }) {
    const transforms = result.transformations || [];

    if (!transforms.length) {
        return (
            <div className="result-panel">
                <div className="empty-state">
                    <div className="empty-state__icon">⚡</div>
                    <div className="empty-state__title">No Transformations Detected</div>
                    <div className="empty-state__desc">The analyzer did not detect data transformations in this repository.</div>
                </div>
            </div>
        );
    }

    // Group by entity
    const grouped = {};
    for (const t of transforms) {
        const key = t.entity || 'General';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(t);
    }

    const entityColors = {
        authors: '#3B82F6', books: '#10B981', reviews: '#F59E0B', users: '#8B5CF6',
        General: '#6B7280',
    };

    return (
        <div className="result-panel">
            <h3 className="result-panel__title">
                <span className="result-panel__title-icon" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>⚡</span>
                Data Transformations
            </h3>
            {Object.entries(grouped).map(([entity, entityTransforms]) => (
                <div key={entity} style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <span style={{
                            display: 'inline-block', padding: '2px 10px', borderRadius: 12,
                            fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                            background: `${entityColors[entity] || '#6B7280'}22`,
                            color: entityColors[entity] || '#6B7280',
                            border: `1px solid ${entityColors[entity] || '#6B7280'}44`,
                        }}>
                            {entity}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {entityTransforms.length} transformation{entityTransforms.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <div className="transform-grid">
                        <div className="transform-row transform-row--header">
                            <div>Name</div>
                            <div>Description</div>
                            <div>Input</div>
                            <div>Output</div>
                        </div>
                        {entityTransforms.map((t, i) => (
                            <div key={i} className="transform-row">
                                <div className="transform-name">{t.name}</div>
                                <div className="transform-desc">{t.description}</div>
                                <div className="transform-io">{t.input_data}</div>
                                <div className="transform-io">{t.output_data}</div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function MetadataPanel({ result }) {
    const meta = result.metadata || {};

    return (
        <div className="result-panel">
            <h3 className="result-panel__title">
                <span className="result-panel__title-icon" style={{ background: 'rgba(236, 72, 153, 0.15)' }}>🗃️</span>
                Metadata & Datasets
            </h3>

            {/* Datasets */}
            {meta.datasets?.length > 0 && (
                <>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, marginTop: 8 }}>Datasets</div>
                    <div className="metadata-grid">
                        {meta.datasets.map((ds, i) => (
                            <div key={i} className="metadata-card">
                                <div className="metadata-card__header">
                                    <div
                                        className="metadata-card__icon"
                                        style={{
                                            background: ds.type === 'input' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                        }}
                                    >
                                        {ds.type === 'input' ? '📥' : '📤'}
                                    </div>
                                    <div className="metadata-card__title">{ds.name}</div>
                                </div>
                                <div className="metadata-card__value">
                                    <span className={`metadata-tag metadata-tag--${ds.type}`}>{ds.type}</span>
                                    <span className="metadata-tag metadata-tag--format">{ds.format}</span>
                                </div>
                                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                                    Source: {ds.source_file}
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}

            {/* Schemas */}
            {meta.schemas?.length > 0 && (
                <>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, marginTop: 24 }}>Table Schemas</div>
                    {meta.schemas.map((schema, i) => (
                        <div key={i} className="metadata-card" style={{ marginBottom: 12 }}>
                            <div className="metadata-card__header">
                                <div className="metadata-card__icon" style={{ background: 'rgba(139, 92, 246, 0.15)' }}>📊</div>
                                <div className="metadata-card__title">{schema.table}</div>
                            </div>
                            <table className="schema-table">
                                <thead>
                                    <tr>
                                        <th>Column</th>
                                        <th>Type</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {schema.columns.map((col, j) => (
                                        <tr key={j}>
                                            <td>{col.name}</td>
                                            <td>{col.type}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))}
                </>
            )}

            {/* Attributes */}
            {meta.attributes && (
                <>
                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, marginTop: 24 }}>Analysis Attributes</div>
                    <div className="metadata-grid">
                        <div className="metadata-card">
                            <div className="metadata-card__header">
                                <div className="metadata-card__icon" style={{ background: 'rgba(6, 182, 212, 0.15)' }}>📁</div>
                                <div className="metadata-card__title">Total Files</div>
                            </div>
                            <div className="metadata-card__value" style={{ fontSize: 22, fontWeight: 700 }}>
                                {meta.attributes.total_files || 0}
                            </div>
                        </div>
                        <div className="metadata-card">
                            <div className="metadata-card__header">
                                <div className="metadata-card__icon" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>🔄</div>
                                <div className="metadata-card__title">Execution Pattern</div>
                            </div>
                            <div className="metadata-card__value" style={{ textTransform: 'capitalize' }}>
                                {meta.attributes.execution_pattern || 'batch'}
                            </div>
                        </div>
                        {meta.attributes.frameworks_detected?.length > 0 && (
                            <div className="metadata-card">
                                <div className="metadata-card__header">
                                    <div className="metadata-card__icon" style={{ background: 'rgba(124, 92, 255, 0.15)' }}>🛠️</div>
                                    <div className="metadata-card__title">Frameworks</div>
                                </div>
                                <div className="metadata-card__value">
                                    {meta.attributes.frameworks_detected.map((fw, i) => (
                                        <span key={i} className="metadata-tag metadata-tag--format">{fw}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
