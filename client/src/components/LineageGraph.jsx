import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import dagre from 'dagre';

export default function LineageGraph({ lineage }) {
    const svgRef = useRef(null);
    const containerRef = useRef(null);
    const [selectedNode, setSelectedNode] = useState(null);

    useEffect(() => {
        if (!lineage?.nodes?.length || !svgRef.current) return;

        const svg = d3.select(svgRef.current);
        svg.selectAll('*').remove();

        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        svg.attr('viewBox', `0 0 ${width} ${height}`);

        // Create dagre graph — use TB for complex graphs, LR for simple
        const nodeCount = lineage.nodes.length;
        const useVertical = nodeCount > 4;
        const g = new dagre.graphlib.Graph();
        g.setGraph({
            rankdir: useVertical ? 'TB' : 'LR',
            nodesep: useVertical ? 60 : 50,
            ranksep: useVertical ? 80 : 120,
            marginx: 40,
            marginy: 40,
        });
        g.setDefaultEdgeLabel(() => ({}));

        const getNodeFill = (node) => {
            const zone = (node.metadata?.zone || '').toLowerCase();
            if (zone.includes('landing') || zone.includes('raw')) return 'rgba(245, 158, 11, 0.15)';
            if (zone.includes('working')) return 'rgba(59, 130, 246, 0.15)';
            if (zone.includes('processed') || zone.includes('silver')) return 'rgba(139, 92, 246, 0.15)';
            if (zone.includes('staging')) return 'rgba(6, 182, 212, 0.15)';
            if (zone.includes('warehouse') || zone.includes('gold')) return 'rgba(16, 185, 129, 0.15)';
            if (node.type === 'data_source') return 'rgba(59, 130, 246, 0.15)';
            return 'rgba(16, 185, 129, 0.15)';
        };

        // Add nodes
        for (const node of lineage.nodes) {
            const label = node.label.length > 24 ? node.label.substring(0, 22) + '…' : node.label;
            const hasColumns = node.metadata?.columns?.length > 0;
            g.setNode(node.id, {
                label,
                width: 190,
                height: 56,
                type: node.type,
                color: node.color,
                fillColor: getNodeFill(node),
                fullLabel: node.label,
                metadata: node.metadata,
                hasColumns,
            });
        }

        // Add edges
        for (const edge of lineage.edges) {
            if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
                g.setEdge(edge.source, edge.target, { label: edge.label || '' });
            }
        }

        dagre.layout(g);

        // Compute bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        g.nodes().forEach((id) => {
            const n = g.node(id);
            if (!n) return;
            minX = Math.min(minX, n.x - n.width / 2);
            minY = Math.min(minY, n.y - n.height / 2);
            maxX = Math.max(maxX, n.x + n.width / 2);
            maxY = Math.max(maxY, n.y + n.height / 2);
        });

        const graphWidth = maxX - minX + 80;
        const graphHeight = maxY - minY + 80;

        // Zoom behavior
        const mainGroup = svg.append('g');

        const zoom = d3.zoom()
            .scaleExtent([0.2, 3])
            .on('zoom', (event) => {
                mainGroup.attr('transform', event.transform);
            });

        svg.call(zoom);

        // Fit to view
        const scale = Math.min(width / graphWidth, height / graphHeight, 1.2) * 0.85;
        const tx = (width - graphWidth * scale) / 2 - minX * scale + 40;
        const ty = (height - graphHeight * scale) / 2 - minY * scale + 40;

        const initialTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);
        svg.call(zoom.transform, initialTransform);

        // Defs — gradient fill + arrows
        const defs = svg.append('defs');

        // Arrow marker
        defs.append('marker')
            .attr('id', 'arrowhead')
            .attr('viewBox', '0 0 10 10')
            .attr('refX', 10)
            .attr('refY', 5)
            .attr('markerWidth', 8)
            .attr('markerHeight', 8)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M 0 0 L 10 5 L 0 10 Z')
            .attr('fill', 'rgba(124, 92, 255, 0.6)');

        // Draw edges with labels
        g.edges().forEach((e) => {
            const edge = g.edge(e);
            if (!edge || !edge.points) return;

            const line = d3.line()
                .x((d) => d.x)
                .y((d) => d.y)
                .curve(d3.curveBasis);

            mainGroup.append('path')
                .attr('d', line(edge.points))
                .attr('fill', 'none')
                .attr('stroke', 'rgba(124, 92, 255, 0.4)')
                .attr('stroke-width', 2)
                .attr('marker-end', 'url(#arrowhead)');

            // Edge label
            if (edge.label) {
                const midPoint = edge.points[Math.floor(edge.points.length / 2)];
                mainGroup.append('text')
                    .attr('x', midPoint.x)
                    .attr('y', midPoint.y - 8)
                    .attr('text-anchor', 'middle')
                    .attr('fill', '#a0a0c0')
                    .attr('font-size', '9px')
                    .attr('font-family', 'Inter, sans-serif')
                    .text(edge.label.length > 30 ? edge.label.substring(0, 28) + '…' : edge.label);
            }
        });

        // Draw nodes as table-shaped cards
        g.nodes().forEach((id) => {
            const node = g.node(id);
            if (!node) return;

            const group = mainGroup.append('g')
                .attr('transform', `translate(${node.x - node.width / 2}, ${node.y - node.height / 2})`)
                .style('cursor', 'pointer');

            // Shadow
            group.append('rect')
                .attr('x', 2)
                .attr('y', 2)
                .attr('width', node.width)
                .attr('height', node.height)
                .attr('rx', 10)
                .attr('ry', 10)
                .attr('fill', 'rgba(0,0,0,0.3)')
                .attr('filter', 'blur(3px)');

            // Main card
            group.append('rect')
                .attr('width', node.width)
                .attr('height', node.height)
                .attr('rx', 10)
                .attr('ry', 10)
                .attr('fill', node.fillColor || 'rgba(59, 130, 246, 0.15)')
                .attr('stroke', node.color || '#6B7280')
                .attr('stroke-width', 2);

            // Table icon (cylinder shape emoji)
            const icon = node.type === 'data_source' ? '🗄️' : '📤';
            group.append('text')
                .attr('x', 14)
                .attr('y', node.height / 2 + 1)
                .attr('dy', '0.35em')
                .attr('font-size', '16px')
                .text(icon);

            // Table name
            group.append('text')
                .attr('x', 38)
                .attr('y', node.height / 2 - 4)
                .attr('dy', '0.35em')
                .attr('fill', '#e0e0ff')
                .attr('font-size', '12px')
                .attr('font-family', 'Inter, sans-serif')
                .attr('font-weight', '600')
                .text(node.label);

            // Format sub-label
            const fmt = node.metadata?.format;
            if (fmt && fmt !== 'unknown') {
                group.append('text')
                    .attr('x', 38)
                    .attr('y', node.height / 2 + 13)
                    .attr('dy', '0.35em')
                    .attr('fill', '#7070a0')
                    .attr('font-size', '9px')
                    .attr('font-family', 'Inter, sans-serif')
                    .text(fmt.toUpperCase());
            }

            // Column indicator badge
            if (node.hasColumns) {
                group.append('rect')
                    .attr('x', node.width - 30)
                    .attr('y', 6)
                    .attr('width', 22)
                    .attr('height', 16)
                    .attr('rx', 4)
                    .attr('fill', 'rgba(124, 92, 255, 0.3)');

                group.append('text')
                    .attr('x', node.width - 19)
                    .attr('y', 16)
                    .attr('text-anchor', 'middle')
                    .attr('fill', '#c0c0ff')
                    .attr('font-size', '9px')
                    .attr('font-family', 'Inter, sans-serif')
                    .attr('font-weight', '700')
                    .text(node.metadata.columns.length);
            }

            // Click handler
            group.on('click', function (event) {
                event.stopPropagation();
                setSelectedNode({
                    id: node.id || id,
                    label: node.fullLabel,
                    type: node.type,
                    metadata: node.metadata,
                });
            });

            // Hover effects
            group.on('mouseover', function () {
                d3.select(this).select('rect:nth-child(2)')
                    .attr('fill-opacity', 0.35)
                    .attr('stroke-width', 3);
            });

            group.on('mouseout', function () {
                d3.select(this).select('rect:nth-child(2)')
                    .attr('fill-opacity', 1)
                    .attr('stroke-width', 2);
            });
        });

        // Click on SVG background to deselect
        svg.on('click', () => setSelectedNode(null));

        // Store zoom for controls
        svgRef.current._zoom = zoom;

    }, [lineage]);

    const handleZoomIn = () => {
        const svg = d3.select(svgRef.current);
        svgRef.current._zoom.scaleBy(svg.transition().duration(300), 1.3);
    };

    const handleZoomOut = () => {
        const svg = d3.select(svgRef.current);
        svgRef.current._zoom.scaleBy(svg.transition().duration(300), 0.7);
    };

    const handleReset = () => {
        const svg = d3.select(svgRef.current);
        svgRef.current._zoom.transform(svg.transition().duration(500), d3.zoomIdentity);
    };

    if (!lineage?.nodes?.length) {
        return (
            <div className="lineage-container" ref={containerRef}>
                <div className="lineage-empty">No table-level lineage data detected</div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', gap: 16 }}>
            {/* Graph */}
            <div className="lineage-container" ref={containerRef} style={{ flex: 1 }}>
                <div className="lineage-controls">
                    <button className="lineage-btn" onClick={handleZoomIn} title="Zoom In">+</button>
                    <button className="lineage-btn" onClick={handleZoomOut} title="Zoom Out">−</button>
                    <button className="lineage-btn" onClick={handleReset} title="Reset">⟲</button>
                </div>

                <svg ref={svgRef} className="lineage-svg" />

                <div className="lineage-legend">
                    <div className="legend-item">
                        <div className="legend-dot" style={{ background: '#F59E0B' }} />
                        Landing/Raw
                    </div>
                    <div className="legend-item">
                        <div className="legend-dot" style={{ background: '#3B82F6' }} />
                        Working
                    </div>
                    <div className="legend-item">
                        <div className="legend-dot" style={{ background: '#8B5CF6' }} />
                        Processed
                    </div>
                    <div className="legend-item">
                        <div className="legend-dot" style={{ background: '#06B6D4' }} />
                        Staging
                    </div>
                    <div className="legend-item">
                        <div className="legend-dot" style={{ background: '#10B981' }} />
                        Warehouse
                    </div>
                </div>
            </div>

            {/* Column details side panel */}
            {selectedNode && (
                <div className="node-detail-panel">
                    <div className="node-detail-panel__header">
                        <div className="node-detail-panel__icon" style={{
                            background: selectedNode.type === 'data_source' ? 'rgba(59,130,246,0.15)' : 'rgba(16,185,129,0.15)',
                        }}>
                            {selectedNode.type === 'data_source' ? '🗄️' : '📤'}
                        </div>
                        <div>
                            <div className="node-detail-panel__title">{selectedNode.label}</div>
                            <div className="node-detail-panel__type">
                                {selectedNode.type === 'data_source' ? 'Source Table' : 'Output Table'}
                            </div>
                        </div>
                        <button className="node-detail-panel__close" onClick={() => setSelectedNode(null)}>✕</button>
                    </div>

                    {/* Format & Framework */}
                    <div className="node-detail-panel__meta">
                        {selectedNode.metadata?.format && selectedNode.metadata.format !== 'unknown' && (
                            <span className="metadata-tag metadata-tag--format">{selectedNode.metadata.format}</span>
                        )}
                        {selectedNode.metadata?.framework && selectedNode.metadata.framework !== 'unknown' && (
                            <span className="metadata-tag metadata-tag--input">{selectedNode.metadata.framework}</span>
                        )}
                    </div>

                    {/* Path */}
                    {selectedNode.metadata?.path && (
                        <div className="node-detail-panel__section">
                            <div className="node-detail-panel__section-title">Path</div>
                            <div className="node-detail-panel__path">{selectedNode.metadata.path}</div>
                        </div>
                    )}

                    {/* Column Lineage */}
                    {selectedNode.metadata?.column_lineage?.length > 0 ? (
                        <div className="node-detail-panel__section">
                            <div className="node-detail-panel__section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Column Lineage</span>
                                <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: 10 }}>
                                    {selectedNode.metadata.column_lineage.length} mapped
                                </span>
                            </div>
                            <div className="node-detail-panel__columns" style={{ gap: 8 }}>
                                {selectedNode.metadata.column_lineage.map((lin, i) => (
                                    <div key={i} className="node-detail-panel__column" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: '10px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 6 }}>
                                            <span className="node-detail-panel__col-name" style={{ fontSize: 13 }}>{lin.output_column}</span>
                                            <span style={{
                                                fontSize: 9, 
                                                textTransform: 'uppercase', 
                                                padding: '2px 6px', 
                                                borderRadius: 4,
                                                background: lin.confidence === 'high' ? 'rgba(16, 185, 129, 0.15)' : 
                                                           lin.confidence === 'medium' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                                color: lin.confidence === 'high' ? '#10B981' : 
                                                       lin.confidence === 'medium' ? '#F59E0B' : '#EF4444'
                                            }}>
                                                {lin.confidence || 'unknown'}
                                            </span>
                                        </div>
                                        
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                                            <span style={{ color: '#8B5CF6' }}>← Sources:</span> {Array.isArray(lin.source_columns) ? lin.source_columns.join(', ') : lin.source_columns || 'None'} 
                                            <span style={{ opacity: 0.6, fontSize: 10 }}> (from {lin.source_dataset || 'unknown'})</span>
                                        </div>
                                        
                                        <div style={{ 
                                            fontSize: 11, 
                                            background: 'rgba(0,0,0,0.2)', 
                                            padding: '4px 8px', 
                                            borderRadius: 4, 
                                            width: '100%',
                                            fontFamily: 'monospace',
                                            color: '#A78BFA'
                                        }}>
                                            <span style={{ opacity: 0.6, userSelect: 'none' }}>fx: </span>
                                            {lin.transformation}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : selectedNode.metadata?.columns?.length > 0 ? (
                        <div className="node-detail-panel__section">
                            <div className="node-detail-panel__section-title">
                                Schema Columns ({selectedNode.metadata.columns.length})
                            </div>
                            <div className="node-detail-panel__columns">
                                {selectedNode.metadata.columns.map((col, i) => (
                                    <div key={i} className="node-detail-panel__column">
                                        <span className="node-detail-panel__col-name">{col.name}</span>
                                        {col.dataType && (
                                            <span className="node-detail-panel__col-type">{col.dataType}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="node-detail-panel__section">
                            <div className="node-detail-panel__section-title">Column Lineage</div>
                            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                                No explicit column transformations inferred.
                            </div>
                        </div>
                    )}

                    {/* Source files */}
                    {selectedNode.metadata?.files?.length > 0 && (
                        <div className="node-detail-panel__section">
                            <div className="node-detail-panel__section-title">Referenced In</div>
                            {selectedNode.metadata.files.map((f, i) => (
                                <div key={i} style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>
                                    📄 {f}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
