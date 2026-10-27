import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
type RecordView = {
  id: string;
  seq: number;
  kind: string;
  payload: any;
  createdAt: string;
  sources?: string[];
};
function App() {
  const [session, setSession] = useState<any>(),
    [runs, setRuns] = useState<any[]>([]),
    [id, setId] = useState(''),
    [savedReport, setReport] = useState<any>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [selected, setSelected] = useState('');
  const load = async () => {
    const list = await fetch('/api/runs').then((r) => r.json());
    setRuns(list);
    return list;
  };
  useEffect(() => {
    void fetch('/api/session')
      .then((r) => r.json())
      .then(setSession);
    void load().then((list) => {
      if (list.length) setId((current) => current || list[0].id);
    });
  }, []);
  useEffect(() => {
    if (!id) return;
    setReport(undefined);
    setSelected('');
    const controller = new AbortController();
    let current = true,
      loading = false;
    let events: EventSource | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (!current || loading) return;
      loading = true;
      try {
        const response = await fetch('/api/runs/' + id, { signal: controller.signal });
        if (!response.ok) throw Error('This saved run could not be loaded.');
        const result = await response.json();
        if (!current || controller.signal.aborted || result.run?.id !== id) return;
        setReport(result);
        if (result.run.state !== 'running') {
          if (timer) clearInterval(timer);
          events?.close();
          void load();
        }
      } catch (e) {
        if (current && !controller.signal.aborted) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    events = new EventSource('/api/runs/' + id + '/events');
    events.onmessage = () => void refresh();
    timer = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => {
      current = false;
      controller.abort();
      events?.close();
      if (timer) clearInterval(timer);
    };
  }, [id]);
  const start = async () => {
    setPending(true);
    setError('');
    try {
      const r = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token },
        body: JSON.stringify({ mode: 'offline', voiceOver: true }),
      });
      const body = await r.json();
      if (!r.ok) throw Error(body.error);
      setId(body.id);
      setSelected('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const stop = async () => {
    const r = await fetch('/api/runs/' + id + '/stop', {
      method: 'POST',
      headers: { 'X-Session-Token': session.token },
    });
    if (!r.ok) setError((await r.json()).error);
  };
  const report = savedReport?.run?.id === id ? savedReport : undefined;
  const records: RecordView[] = report?.records ?? [],
    captures = records.filter((r) => r.kind === 'capture'),
    capture = selected ? captures.find((r) => r.id === selected) : captures.at(-1),
    at = records.filter((r) => r.kind === 'at_check'),
    active = report?.run?.state === 'running';
  const showOriginal = (finding: any) => {
    for (const id of finding.evidence) {
      const observation = records.find((r) => r.id === id);
      const captureId =
        observation?.kind === 'capture'
          ? observation.id
          : observation?.sources?.find((source) => captures.some((c) => c.id === source));
      if (captureId) {
        setSelected(captureId);
        return;
      }
    }
    setSelected('missing-original');
    setError(
      'The original page for this finding is unavailable. An unrelated capture will not be substituted.',
    );
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="top">
        <a href="/" className="brand">
          <span aria-hidden="true">a.</span> Access Walk
        </a>
        <span className="prototype">META HACKATHON · WORK IN PROGRESS</span>
        <span className="budget">
          Credits spent <strong>${((report?.usage?.spent ?? 0) / 1e6).toFixed(2)}</strong>
        </span>
      </header>
      <main id="main">
        <section className="intro">
          <div>
            <p className="eyebrow">AN INDEPENDENT WAY THROUGH</p>
            <h1>
              Find the barriers.
              <br />
              <span>Keep the evidence.</span>
            </h1>
            <p className="lead">
              Follow an everyday task through a website. Examine real keyboard actions,
              screen-reader output and the page itself, in one shared record.
            </p>
          </div>
          <aside className="setup">
            <span className="pill">Day 1–2 foundation</span>
            <h2>Try the controlled example</h2>
            <p>A small shop built for this project, with known accessible and broken controls.</p>
            <button onClick={start} disabled={!session || pending || active}>
              {pending ? 'Starting…' : 'Start saved demo'} <span aria-hidden="true">↗</span>
            </button>
            <p className="caption">
              No AI calls or credit spending. Real browser actions; saved analysis and review
              examples.
            </p>
            <p className="small">
              VoiceOver setup:{' '}
              {session?.voiceOver?.controlEnabled
                ? 'control setting enabled; actual operation still needs proof'
                : 'setup required on this Mac'}
            </p>
          </aside>
        </section>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <section className="workspace" aria-label="Run workspace">
          <aside className="run-list">
            <h2>Your runs</h2>
            {runs.length ? (
              runs.map((r) => (
                <button
                  data-run-id={r.id}
                  key={r.id}
                  className={id === r.id ? 'run selected' : 'run'}
                  aria-pressed={id === r.id}
                  onClick={() => {
                    setId(r.id);
                    setSelected('');
                  }}
                >
                  <strong>Controlled shop</strong>
                  <span>
                    {new Date(r.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {r.state}
                  </span>
                </button>
              ))
            ) : (
              <p>No runs yet. Start the saved demo above.</p>
            )}
            <div className="method">
              <h3>One shared record</h3>
              <p>
                Original walk → keyboard and VoiceOver evidence → analysis → independent review.
              </p>
              <p>Missing evidence remains visible. An unfinished check does not become a pass.</p>
            </div>
          </aside>
          <div className="run-body" data-report-run-id={report?.run.id}>
            {report ? (
              <>
                <div className="run-heading">
                  <div>
                    <p className="eyebrow">
                      {report.run.mode === 'offline' ? 'SAVED RESPONSE DEMONSTRATION' : 'LIVE RUN'}
                    </p>
                    <h2>Canvas bag → basket</h2>
                  </div>
                  <div>
                    <span className="state" role="status" aria-live="polite">
                      {report.run.state}
                    </span>
                    {active && (
                      <button className="secondary" onClick={stop}>
                        Stop run
                      </button>
                    )}
                  </div>
                </div>
                <p className="scope">
                  {report.run.stopReason ??
                    'The robot is collecting original observations. Findings wait for review.'}
                </p>
                <div className="run-grid">
                  <section className="evidence" aria-labelledby="evidence-title">
                    <div className="section-heading">
                      <h3 id="evidence-title">Original page evidence</h3>
                      <span>{captures.length} captures</span>
                    </div>
                    {capture ? (
                      <>
                        <img
                          src={`/api/runs/${id}/assets/${capture.payload.imageFile}`}
                          alt={`Captured page: ${capture.payload.title}. Equivalent actions and observations appear below.`}
                        />
                        <label className="capture-select">
                          Examine a captured state
                          <select value={capture.id} onChange={(e) => setSelected(e.target.value)}>
                            {captures.map((c, i) => (
                              <option key={c.id} value={c.id}>
                                State {i + 1} · {c.payload.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <details>
                          <summary>Read page information as text</summary>
                          <pre>{capture.payload.aria}</pre>
                        </details>
                      </>
                    ) : (
                      <p>Captures will appear here.</p>
                    )}
                  </section>
                  <section className="findings" aria-labelledby="findings-title">
                    <div className="section-heading">
                      <h3 id="findings-title">Reviewed findings</h3>
                      <span>{report.findings.length}</span>
                    </div>
                    {report.findings.length ? (
                      report.findings.map((f: any) => (
                        <article className="finding" key={f.id}>
                          <span className="pill warm">Saved review example · {f.criterion}</span>
                          <h4>{f.title}</h4>
                          <p>{f.detail}</p>
                          <h5>Suggested action</h5>
                          <p>{f.recommendation}</p>
                          <button className="secondary" onClick={() => showOriginal(f)}>
                            Show original captured page
                          </button>
                          <details>
                            <summary>Read the supporting observation</summary>
                            {f.evidence.map((source: string) => {
                              const r = records.find((x) => x.id === source);
                              return (
                                <pre key={source}>
                                  {r
                                    ? JSON.stringify(r.payload, null, 2)
                                    : 'Original evidence unavailable.'}
                                </pre>
                              );
                            })}
                          </details>
                        </article>
                      ))
                    ) : (
                      <div className="empty">
                        <span aria-hidden="true">◎</span>
                        <h4>{active ? 'Checking the evidence' : 'No published findings'}</h4>
                        <p>
                          {active
                            ? 'A candidate stays internal until review accepts it.'
                            : 'No finding is not proof that the page is accessible. Check the coverage below.'}
                        </p>
                      </div>
                    )}
                    <p className="small">
                      SAM has not been called. No outline is presented as SAM output.
                    </p>
                  </section>
                </div>
                <section className="checks">
                  <div className="section-heading">
                    <h3>What was actually checked</h3>
                    <span>Scope and limits</span>
                  </div>
                  <div className="check-grid">
                    <article>
                      <h4>Keyboard walk</h4>
                      <p>
                        {records.filter((r) => r.kind === 'action').length} actual actions recorded.
                      </p>
                      <details>
                        <summary>Read key actions and focus</summary>
                        {records
                          .filter((r) => r.kind === 'action')
                          .map((r) => (
                            <pre key={r.id}>{JSON.stringify(r.payload, null, 2)}</pre>
                          ))}
                      </details>
                    </article>
                    <article>
                      <h4>Real VoiceOver</h4>
                      {at.length ? (
                        at.map((r) => (
                          <div key={r.id}>
                            <p>
                              {r.payload.state}: {r.payload.reason ?? r.payload.limit}
                            </p>
                            <details>
                              <summary>Read commands and spoken output</summary>
                              <pre>{JSON.stringify(r.payload, null, 2)}</pre>
                            </details>
                          </div>
                        ))
                      ) : (
                        <p>Not tested yet.</p>
                      )}
                    </article>
                    <article>
                      <h4>Full assessment</h4>
                      <p>
                        The complete fifteen-criterion review and model accuracy have not been
                        tested. No overall score is shown.
                      </p>
                      <p>Reserved spending: ${((report.usage.reserved ?? 0) / 1e6).toFixed(2)}</p>
                    </article>
                  </div>
                </section>
              </>
            ) : (
              <div className="welcome">
                <span aria-hidden="true">↗</span>
                <h2>A task, a walk, a record.</h2>
                <p>
                  Start the controlled example to see browser evidence arrive here. Reopening a run
                  never starts another audit.
                </p>
              </div>
            )}
          </div>
        </section>
        <footer>
          Built fresh for the Meta hackathon. Cavioo is prior work; its code and services are not
          part of this project. Access Walk is a working name.
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
