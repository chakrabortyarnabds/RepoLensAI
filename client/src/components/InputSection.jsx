import { useState, useRef } from 'react';

export default function InputSection({ onAnalyze, isLoading }) {
    const [githubUrl, setGithubUrl] = useState('');
    const [zipFile, setZipFile] = useState(null);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef(null);

    const handleSubmit = () => {
        if (zipFile) {
            onAnalyze(null, zipFile);
        } else if (githubUrl.trim()) {
            onAnalyze(githubUrl.trim(), null);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragging(false);
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].name.endsWith('.zip')) {
            setZipFile(files[0]);
        }
    };

    const hasInput = githubUrl.trim() || zipFile;

    return (
        <section className="input-section">
            <div className="input-card">
                <h2 className="input-card__title">Analyze a Repository</h2>
                <p className="input-card__desc">
                    Enter a public GitHub URL or upload a ZIP file to generate documentation, lineage, and insights.
                </p>

                <div className="input-methods">
                    <div className="input-method">
                        <label className="input-method__label">GitHub Repository</label>
                        <div className="input-method__field">
                            <input
                                type="text"
                                className="input-method__input"
                                placeholder="https://github.com/owner/repo"
                                value={githubUrl}
                                onChange={(e) => {
                                    setGithubUrl(e.target.value);
                                    if (e.target.value) setZipFile(null);
                                }}
                                disabled={isLoading}
                            />
                        </div>
                    </div>

                    <div className="divider">OR</div>

                    <div className="input-method">
                        <label className="input-method__label">Upload ZIP</label>
                        <div
                            className={`upload-zone ${dragging ? 'dragging' : ''}`}
                            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <div className="upload-zone__icon">📦</div>
                            <div className="upload-zone__text">
                                {zipFile
                                    ? null
                                    : 'Drag & drop a ZIP file or click to browse'}
                            </div>
                            {zipFile && (
                                <div className="upload-zone__selected">
                                    ✓ {zipFile.name} ({(zipFile.size / 1024 / 1024).toFixed(1)} MB)
                                </div>
                            )}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".zip"
                                onChange={(e) => {
                                    if (e.target.files[0]) {
                                        setZipFile(e.target.files[0]);
                                        setGithubUrl('');
                                    }
                                }}
                            />
                        </div>
                    </div>
                </div>

                <button
                    className="analyze-btn"
                    onClick={handleSubmit}
                    disabled={!hasInput || isLoading}
                >
                    {isLoading ? '⏳ Analyzing...' : '🔍 Analyze Repository'}
                </button>
            </div>
        </section>
    );
}
