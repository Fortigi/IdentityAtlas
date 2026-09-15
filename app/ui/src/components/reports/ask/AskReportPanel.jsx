// PROTOTYPE — "Ask for a report": natural language → local LLM → editable
// report definition → read-only query → table.
//
// Flow: the analyst types a question. The API asks the local model to fill a
// report definition (or to ask one clarifying question). The definition is shown
// as editable criteria plus the server's plain-language reading of it; the
// analyst corrects what's wrong and runs it. Follow-up messages refine the same
// report ("also show the department"). Timings are shown on purpose: this
// prototype exists to find out whether a CPU-only model is fast and good enough.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import ListReportRenderer from '@ui/components/reports/ListReportRenderer';
import SpecEditor from './SpecEditor';

const EXAMPLES = [
  'All guest accounts that don\'t have a manager or where the manager is disabled',
  'All groups that have HAMIS in the name',
  'All users that are disabled but still member of a group that contains LIC',
];
const BEST_GUESS = 'Use your best judgement and produce the report.';
const MODEL_KEY = 'nlReports.model';

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800';
const PRIMARY = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';
const SECONDARY = 'rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800 hover:border-blue-400 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200';
const MUTED = 'text-xs text-gray-600 dark:text-gray-400';

function readStoredModel() {
  try { return localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; }
}

function useElapsed(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 500);
    return () => { clearInterval(id); setSeconds(0); };
  }, [active]);
  return seconds;
}

function formatTiming(t, model) {
  if (!t) return '';
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  return `${model} · ${s(t.totalMs)} total · read ${t.promptTokens} tokens in ${s(t.promptMs)} · wrote ${t.outputTokens} tokens in ${s(t.outputMs)}${t.loadMs > 1000 ? ` · model load ${s(t.loadMs)}` : ''}`;
}

async function postJson(authFetch, url, body) {
  const res = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.errors?.length ? `: ${json.errors.join('; ')}` : '';
    throw new Error(`${json.error || `Request failed (${res.status})`}${detail}`);
  }
  return json;
}

function Interpretation({ explanation }) {
  if (!explanation) return null;
  return (
    <div className="text-sm text-gray-800 dark:text-gray-200">
      <p className="font-medium">{explanation.title}</p>
      <ul className="mt-1 space-y-0.5">
        {explanation.lines.map((l, i) => (
          <li key={i} style={{ paddingLeft: `${(l.depth + 1) * 1.25}rem` }}>• {l.text}</li>
        ))}
      </ul>
    </div>
  );
}

function Turn({ turn, onAnswer, busy, isLast }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-3xl rounded-lg bg-blue-50 px-3 py-2 text-sm text-gray-900 dark:bg-blue-900/30 dark:text-gray-100">{turn.text}</p>
      </div>
    );
  }
  const r = turn.reply;
  return (
    <div className="max-w-3xl space-y-2 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700/50 dark:text-gray-100">
      {r.kind === 'clarify' && (
        <>
          <p>{r.question}</p>
          {isLast && (
            <div className="flex flex-wrap gap-2">
              {r.options.map(o => <button key={o} type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(o)}>{o}</button>)}
              <button type="button" disabled={busy} className={SECONDARY} onClick={() => onAnswer(BEST_GUESS)}>Use your best guess</button>
            </div>
          )}
        </>
      )}
      {r.kind === 'report' && (
        <>
          <p>Here is how I understood it{r.repaired ? ' (after correcting my first attempt)' : ''}:</p>
          <Interpretation explanation={r.explanation} />
          {r.assumptions?.length > 0 && (
            <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
              {r.assumptions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          )}
        </>
      )}
      {r.kind === 'error' && <p className="text-red-700 dark:text-red-300">{r.message}{r.errors?.length ? ` (${r.errors.join('; ')})` : ''}</p>}
      <p className={MUTED}>{formatTiming(r.timing, r.model)}</p>
    </div>
  );
}

export default function AskReportPanel({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data: catalog, error: catalogError } = useFetch('/api/nl-reports/catalog', { authFetch });
  const { data: modelData, error: modelsError } = useFetch('/api/nl-reports/models', { authFetch });

  const [model, setModel] = useState(readStoredModel);
  const [warm, setWarm] = useState({ state: 'idle', ms: 0 });
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState([]);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [spec, setSpec] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  const elapsed = useElapsed(busy || warm.state === 'warming');
  const warmedFor = useRef('');

  const models = modelData?.models || [];
  const activeModel = model || modelData?.defaultModel || '';

  // Load the model and pre-read the prompt as soon as the panel is opened, so
  // the analyst's first question doesn't pay for it.
  useEffect(() => {
    if (!activeModel || warmedFor.current === activeModel) return;
    warmedFor.current = activeModel;
    let cancelled = false;
    setWarm({ state: 'warming', ms: 0 });
    postJson(authFetch, '/api/nl-reports/warm', { model: activeModel })
      .then(r => { if (!cancelled) setWarm({ state: 'ready', ms: r.ms }); })
      .catch(() => { if (!cancelled) setWarm({ state: 'error', ms: 0 }); });
    return () => { cancelled = true; };
  }, [activeModel, authFetch]);

  const chooseModel = (m) => {
    setModel(m);
    try { localStorage.setItem(MODEL_KEY, m); } catch { /* private window */ }
  };

  const run = async (s) => {
    setRunning(true);
    setError(null);
    try {
      const r = await postJson(authFetch, '/api/nl-reports/run', { spec: s });
      setResult(r);
      setSpec(r.spec);
      setDirty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const ask = async (text) => {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    setTurns(t => [...t, { role: 'user', text: question }]);
    try {
      const reply = await postJson(authFetch, '/api/nl-reports/interpret', { question, history, model: activeModel });
      setTurns(t => [...t, { role: 'assistant', reply }]);
      setHistory(h => [...h, { role: 'user', content: question }, { role: 'assistant', content: reply.raw || '' }]);
      if (reply.kind === 'report') {
        setLastReport(reply);
        setSpec(reply.spec);
        await run(reply.spec);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setTurns([]); setHistory([]); setSpec(null); setResult(null); setError(null); setLastReport(null); setDirty(false);
  };

  if (catalogError || modelsError) {
    return <div className={`${CARD} text-sm text-red-700 dark:text-red-300`}>Ask for a report is unavailable: {(catalogError || modelsError).message}</div>;
  }

  const started = turns.length > 0;
  const lastTurn = turns[turns.length - 1];
  const awaitingAnswer = lastTurn?.role === 'assistant' && lastTurn.reply.kind === 'clarify';

  return (
    <section className={`${CARD} mb-6 space-y-4`} aria-labelledby="ask-report-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="ask-report-heading" className="text-base font-semibold text-gray-900 dark:text-white">
            Ask for a report <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">prototype · local model</span>
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Describe the report in your own words. A model running on this server turns it into criteria you can check and edit — it never sees the data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="nl-model" className="text-sm text-gray-700 dark:text-gray-300">Model</label>
          <select id="nl-model" className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
            value={activeModel} onChange={e => chooseModel(e.target.value)} disabled={busy}>
            {models.map(m => <option key={m.name} value={m.name}>{m.name} ({m.parameterSize})</option>)}
          </select>
          <span className={MUTED} aria-live="polite">
            {warm.state === 'warming' && `warming up… ${elapsed}s`}
            {warm.state === 'ready' && 'ready'}
            {warm.state === 'error' && 'model server unreachable'}
          </span>
        </div>
      </div>

      {started && (
        <div className="space-y-3">
          {turns.map((t, i) => <Turn key={i} turn={t} busy={busy} isLast={i === turns.length - 1} onAnswer={ask} />)}
        </div>
      )}

      {busy && <p className={MUTED} aria-live="polite">Thinking… {elapsed}s{warm.state === 'warming' ? ' (the model is still warming up)' : ''}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

      <form className="space-y-2" onSubmit={e => { e.preventDefault(); ask(input); }}>
        <label htmlFor="nl-question" className="sr-only">
          {awaitingAnswer ? 'Your answer' : spec ? 'Refine the report' : 'Describe the report you want'}
        </label>
        <textarea id="nl-question" rows={2} value={input} disabled={busy}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          placeholder={awaitingAnswer ? 'Or type your own answer…' : spec ? 'Refine it, e.g. "also show the department"…' : 'e.g. all guest accounts without a manager'}
          className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-500" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={PRIMARY} disabled={busy || !input.trim()}>{spec ? 'Refine' : 'Ask'}</button>
          {started && <button type="button" className={SECONDARY} onClick={reset} disabled={busy}>New question</button>}
          {!started && EXAMPLES.map(ex => (
            <button key={ex} type="button" className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-300" onClick={() => ask(ex)} disabled={busy}>
              {ex}
            </button>
          ))}
        </div>
      </form>

      {spec && catalog && (
        <div className="grid gap-4 border-t border-gray-200 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] dark:border-gray-700">
          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Report definition</h4>
            <SpecEditor spec={spec} catalog={catalog} onChange={s => { setSpec(s); setDirty(true); }} />
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className={PRIMARY} disabled={running} onClick={() => run(spec)}>{running ? 'Running…' : dirty ? 'Run with changes' : 'Run again'}</button>
              {dirty && <span className={MUTED}>edited — not run yet</span>}
            </div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">What will run</h4>
            <Interpretation explanation={result?.explanation} />
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-700 dark:text-gray-300">SQL ({result?.elapsedMs ?? '–'} ms)</summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{result?.sql}{result?.params ? `\n\n-- params: ${JSON.stringify(result.params)}` : ''}</pre>
            </details>
            {lastReport?.raw && (
              <details className="text-sm">
                <summary className="cursor-pointer text-gray-700 dark:text-gray-300">Raw model output</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{(() => { try { return JSON.stringify(JSON.parse(lastReport.raw), null, 2); } catch { return lastReport.raw; } })()}</pre>
              </details>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {result.total} row{result.total === 1 ? '' : 's'}{result.truncated ? ' (first rows only — narrow the criteria)' : ''}
          </p>
          <ListReportRenderer report={{ displayName: 'This report', columns: result.columns, rows: result.rows }} onOpenDetail={onOpenDetail} />
        </div>
      )}
    </section>
  );
}
