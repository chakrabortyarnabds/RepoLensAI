import { useState, useEffect, useRef } from 'react';
import InputSection from './components/InputSection';
import ResultsDashboard from './components/ResultsDashboard';
import { startAnalysis, getStatus, getResults } from './utils/api';
import './App.css';

function App() {
  const [isLoading, setIsLoading] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState({ progress: 0, currentStep: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const handleAnalyze = async (githubUrl, zipFile) => {
    setIsLoading(true);
    setResult(null);
    setError(null);
    setProgress({ progress: 0, currentStep: 'Starting analysis...' });

    try {
      const { jobId: id } = await startAnalysis(githubUrl, zipFile);
      setJobId(id);
      startPolling(id);
    } catch (err) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  const startPolling = (id) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const status = await getStatus(id);
        setProgress({
          progress: status.progress || 0,
          currentStep: status.currentStep || '',
        });

        if (status.status === 'completed' || status.status === 'failed') {
          clearInterval(pollRef.current);
          pollRef.current = null;

          const resultData = await getResults(id);
          if (resultData.result) {
            setResult(resultData.result);
          } else if (resultData.status === 'failed') {
            setError('Analysis failed. Please try again with a different repository.');
          }
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1500);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="header__logo">
          <div className="header__icon">🔍</div>
          <div>
            <div className="header__title">RepoLens AI</div>
            <div className="header__subtitle">Multi-Agent Code Analyzer</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Powered by Gemini 2.5 Pro
          </span>
        </div>
      </header>

      <main className="main">
        <InputSection onAnalyze={handleAnalyze} isLoading={isLoading} />

        {/* Progress */}
        {isLoading && (
          <div className="progress-section">
            <div className="progress-card">
              <div className="progress-header">
                <div className="progress-header__title">🧠 Multi-Agent Analysis Running</div>
                <div className="progress-header__percent">{progress.progress}%</div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-bar__fill"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              <div className="progress-step">
                <span className="progress-step__dot" />
                {progress.currentStep}
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="result-panel" style={{ borderColor: 'var(--color-red)', marginBottom: 24 }}>
            <div style={{ color: 'var(--color-red)', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              ❌ Error
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>{error}</div>
          </div>
        )}

        {/* Results */}
        {result && <ResultsDashboard result={result} />}

        {/* Empty state */}
        {!isLoading && !result && !error && (
          <div className="empty-state">
            <div className="empty-state__icon">🔬</div>
            <div className="empty-state__title">Ready to Analyze</div>
            <div className="empty-state__desc">
              Enter a GitHub URL or upload a ZIP file above to generate documentation, data lineage, and pipeline insights.
            </div>
          </div>
        )}
      </main>

      <footer style={{
        textAlign: 'center',
        padding: '20px',
        color: 'var(--text-muted)',
        fontSize: '12px',
        borderTop: '1px solid var(--border-light)',
      }}>
        RepoLens AI — Multi-Agent Repository Analyzer
      </footer>
    </div>
  );
}

export default App;
