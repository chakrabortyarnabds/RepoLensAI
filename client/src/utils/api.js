const API_BASE = '/api';

export async function startAnalysis(githubUrl, zipFile) {
    const formData = new FormData();
    if (zipFile) {
        formData.append('zipFile', zipFile);
    } else {
        formData.append('githubUrl', githubUrl);
    }

    const isJson = !zipFile;
    const options = {
        method: 'POST',
    };

    if (isJson) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ githubUrl });
    } else {
        options.body = formData;
    }

    const res = await fetch(`${API_BASE}/analyze`, options);
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to start analysis');
    }
    return res.json();
}

export async function getStatus(jobId) {
    const res = await fetch(`${API_BASE}/status/${jobId}`);
    if (!res.ok) throw new Error('Failed to fetch status');
    return res.json();
}

export async function getResults(jobId) {
    const res = await fetch(`${API_BASE}/results/${jobId}`);
    if (!res.ok) throw new Error('Failed to fetch results');
    return res.json();
}

export function exportAsMarkdown(result) {
    let md = `# RepoLens AI — Analysis Report\n\n`;
    md += `_Generated on ${new Date().toLocaleString()}_\n\n`;

    md += `## Summary\n\n${result.summary}\n\n`;

    if (result.steps?.length) {
        md += `## Pipeline Steps\n\n`;
        for (const step of result.steps) {
            md += `### Step ${step.step_number}: ${step.title}\n\n`;
            md += `${step.description}\n\n`;
            if (step.input) md += `- **Input:** ${step.input}\n`;
            if (step.output) md += `- **Output:** ${step.output}\n`;
            md += `\n`;
        }
    }

    if (result.transformations?.length) {
        md += `## Transformations\n\n`;
        md += `| # | Name | Description |\n|---|------|-------------|\n`;
        for (const t of result.transformations) {
            md += `| ${t.id} | ${t.name} | ${t.description} |\n`;
        }
        md += `\n`;
    }

    if (result.metadata?.datasets?.length) {
        md += `## Datasets\n\n`;
        md += `| Name | Type | Format | Source File |\n|------|------|--------|-------------|\n`;
        for (const d of result.metadata.datasets) {
            md += `| ${d.name} | ${d.type} | ${d.format} | ${d.source_file} |\n`;
        }
        md += `\n`;
    }

    return md;
}

export function exportAsHTML(result) {
    const md = exportAsMarkdown(result);
    // Simple markdown to HTML conversion
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RepoLens AI Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1a1a2e; line-height: 1.7; }
    h1 { color: #7c5cff; border-bottom: 3px solid #7c5cff; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    h3 { color: #555; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f8ff; font-weight: 600; }
    code { background: #f0f0ff; padding: 2px 6px; border-radius: 4px; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>`;

    // Simple conversion
    html += md
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        .replace(/^\- \*\*(.*?)\*\* (.*$)/gm, '<li><strong>$1</strong> $2</li>')
        .replace(/^_(.*?)_$/gm, '<em>$1</em>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\|(.+)\|/g, (match) => {
            const cells = match.split('|').filter((c) => c.trim());
            if (cells.every((c) => c.trim().match(/^-+$/))) return '';
            const tag = cells.some((c) => c.trim().match(/^[A-Z#]/)) ? 'th' : 'td';
            return `<tr>${cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;
        });

    html += `</body></html>`;
    return html;
}

export function downloadFile(content, filename, type = 'text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
