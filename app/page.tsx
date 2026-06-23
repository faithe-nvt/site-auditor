'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Phase = 'idle' | 'crawling' | 'auditing' | 'done' | 'error';

export default function Home() {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [report, setReport] = useState('');
  const reportRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (reportRef.current) {
      reportRef.current.scrollTop = reportRef.current.scrollHeight;
    }
  }, [report]);

  async function runAudit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setPhase('crawling');
    setProgressLines([]);
    setReport('');

    try {
      const res = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Server error: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reportStarted = false;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('[PROGRESS]')) {
            const msg = line.slice('[PROGRESS]'.length);
            setProgressLines(prev => [...prev, msg]);
            if (msg.toLowerCase().includes('ai audit')) setPhase('auditing');
          } else if (line === '[REPORT_START]') {
            reportStarted = true;
          } else if (reportStarted) {
            setReport(prev => prev + line + '\n');
          }
        }

        if (reportStarted && buffer) {
          setReport(prev => prev + buffer);
          buffer = '';
        }
      }

      setPhase('done');
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setPhase('error');
        setReport(`**Error:** ${String(err)}`);
      }
    }
  }

  function copyReport() {
    navigator.clipboard.writeText(report);
  }

  function reset() {
    abortRef.current?.abort();
    setPhase('idle');
    setProgressLines([]);
    setReport('');
  }

  const isRunning = phase === 'crawling' || phase === 'auditing';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Site Auditor</h1>
            <p className="text-sm text-gray-500">NVT internal QA + SEO tool</p>
          </div>
          {phase !== 'idle' && (
            <button onClick={reset} className="text-sm text-gray-500 hover:text-gray-800 underline">
              Start over
            </button>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <form onSubmit={runAudit} className="mb-8">
          <label className="block text-sm font-medium text-gray-700 mb-2">Website URL</label>
          <div className="flex gap-3">
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="netavirtualteam.com.au"
              disabled={isRunning}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-400"
            />
            <button
              type="submit"
              disabled={isRunning || !url.trim()}
              className="px-5 py-2.5 bg-teal-700 text-white text-sm font-medium rounded-lg hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isRunning ? 'Running...' : 'Run Audit'}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-gray-400">
            Crawls up to 30 pages. Allow 30–90 seconds depending on site size.
          </p>
        </form>

        {(progressLines.length > 0 || isRunning) && (
          <div className="mb-6 bg-gray-900 rounded-lg p-4 font-mono text-xs">
            <div className="text-gray-400 mb-2 text-xs uppercase tracking-wider">
              {phase === 'crawling' ? 'Crawling site...' : phase === 'auditing' ? 'Running AI audit...' : 'Complete'}
            </div>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {progressLines.map((line, i) => (
                <div key={i} className="text-green-400">{line}</div>
              ))}
              {isRunning && <div className="text-green-400 animate-pulse">_</div>}
            </div>
          </div>
        )}

        {report && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-700">
                Audit Report
                {phase === 'done' && <span className="ml-2 text-xs text-green-600 font-normal">Complete</span>}
                {phase === 'auditing' && <span className="ml-2 text-xs text-teal-600 font-normal animate-pulse">Writing...</span>}
              </span>
              {phase === 'done' && (
                <button
                  onClick={copyReport}
                  className="text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-3 py-1 hover:bg-gray-50 transition-colors"
                >
                  Copy report
                </button>
              )}
            </div>
            <div ref={reportRef} className="px-6 py-6 overflow-y-auto max-h-[65vh] text-sm text-gray-700 leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-4">
                      <table className="min-w-full border-collapse text-xs text-gray-700">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead>{children}</thead>,
                  tbody: ({ children }) => <tbody>{children}</tbody>,
                  tr: ({ children }) => <tr className="border-b border-gray-100">{children}</tr>,
                  th: ({ children }) => (
                    <th className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-700">{children}</th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-gray-200 px-3 py-2 text-gray-600 align-top">{children}</td>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-base font-semibold text-gray-900 mt-8 mb-3 pb-2 border-b border-gray-100">{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-sm font-semibold text-gray-800 mt-5 mb-2">{children}</h3>
                  ),
                  h4: ({ children }) => (
                    <h4 className="text-sm font-medium text-gray-800 mt-4 mb-1">{children}</h4>
                  ),
                  p: ({ children }) => (
                    <p className="text-gray-700 mb-3 leading-relaxed">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc list-outside ml-5 mb-3 space-y-1 text-gray-700">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal list-outside ml-5 mb-3 space-y-1 text-gray-700">{children}</ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-gray-700 leading-relaxed">{children}</li>
                  ),
                  code: ({ children }) => (
                    <code className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-gray-200 pl-4 text-gray-500 italic my-3">{children}</blockquote>
                  ),
                  strong: ({ children }) => {
                    const text = String(children);
                    const cls = text.includes('Critical') ? 'text-red-700 font-semibold'
                      : text.includes('High') ? 'text-orange-600 font-semibold'
                      : text.includes('Medium') ? 'text-yellow-700 font-semibold'
                      : text.includes('Low') ? 'text-gray-500 font-semibold'
                      : 'text-gray-900 font-semibold';
                    return <strong className={cls}>{children}</strong>;
                  },
                  hr: () => <hr className="border-gray-100 my-6" />,
                }}
              >
                {report}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {phase === 'error' && !report && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-6 py-4 text-sm text-red-700">
            Something went wrong. Check that the URL is reachable and your GROQ_API_KEY is set in .env.local.
          </div>
        )}
      </main>
    </div>
  );
}
