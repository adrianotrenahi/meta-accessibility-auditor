import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BriefScreen } from "@/app/audits/new/BriefScreen";
import { RunProgress } from "@/app/audits/new/RunProgress";
import AuditListClient from "@/components/audits/AuditListClient";
import AuditReportClient from "@/components/audits/AuditReportClient";
import { EditorialTopNav } from "@/components/app-shell/EditorialTopNav";
import { DarkReady } from "@/components/DarkReady";
import { CavCallout } from "@/components/ui/CavCallout";
import { CavButton } from "@/components/ui/CavButton";
import { acceptMetaFunnelJob, metaPendingStartsSchema, type MetaFunnelJob } from "@/lib/metaFunnelState";
import { metaWalkSession } from "@/lib/metaFunnel";
import { useProofLocation, navigate } from "./funnel-navigation";
import { ReviewedEnginePins } from "./ReviewedEnginePins";
import { useMetaBrowserFeed } from "./useMetaBrowserFeed";
const capabilities = { liveBrowser: true, deleteScreens: false };
type Bootstrap = { url: string | null; goal: string | null; mode: "offline" | "live"; capabilities?: { publicWebsites?: boolean } };
function App({ bootstrap }: { bootstrap: Bootstrap }) {
  const href = useProofLocation(),
    path = new URL(href).pathname;
  const jobId =
    path.match(/^\/audits\/(?:run\/)?([a-f0-9-]{36})$/)?.[1] ?? null;
  const history = path === "/audits" || path === "/";
  const running = path.startsWith("/audits/run/"),
    report = !!jobId && !running;
  const liveProof = bootstrap.mode === "live";
  const publicSites = bootstrap.capabilities?.publicWebsites === true;
  const [storedJob, setJob] = useState<MetaFunnelJob | null>(null),
    [error, setError] = useState<string | null>(null),
    [readError, setReadError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [pendingStarts, setPendingStarts] = useState<ReturnType<typeof metaPendingStartsSchema.parse>["pendingStarts"]>([]);
  useEffect(() => {
    if (!publicSites || jobId) return;
    let closed = false, inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/offline/pending-starts", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error();
        const next = metaPendingStartsSchema.parse(await response.json());
        if (!closed) setPendingStarts(next.pendingStarts);
      } catch { /* A failed read never invents, resumes or removes a Start. */ }
      finally { inFlight = false; }
    };
    void read();
    const timer = setInterval(read, 1000);
    return () => { closed = true; clearInterval(timer); };
  }, [publicSites, jobId]);
  const job = storedJob?.jobId === jobId ? storedJob : null;
  const acceptedJob = useRef<MetaFunnelJob | null>(null);
  const discardRetryButton = useRef<HTMLButtonElement>(null);
  const failedDiscardFocus = useRef<{ jobId: string; trigger: Element | null } | null>(null);
  const unavailableJob = useRef<string | null>(null);
  const activeJobId = useRef(jobId);
  activeJobId.current = jobId;
  const accept = useCallback((data: unknown, expectedId: string) => {
    if (
      activeJobId.current !== expectedId ||
      unavailableJob.current === expectedId
    )
      return;
    const next = acceptMetaFunnelJob(acceptedJob.current, data, expectedId);
    acceptedJob.current = next;
    if (next.deleted) setPendingStarts((pending) => pending.filter((item) => item.jobId !== expectedId));
    setJob(next);
  }, []);
  const browserFeed = useMetaBrowserFeed(
    jobId,
    job?.snapshot?.run.id ?? null,
    running && job?.snapshot?.run.state === "running" && !job.deleted,
  );
  useEffect(() => {
    acceptedJob.current = null;
    unavailableJob.current = null;
    if (!jobId) {
      setJob(null);
      return;
    }
    let closed = false,
      inFlight = false;
    let controller: AbortController | null = null;
    setJob(null);
    setBusy(false);
    setError(null);
    setReadError(null);
    const poll = async () => {
      if (inFlight || unavailableJob.current === jobId) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 6000);
      try {
        const response = await fetch(`/api/offline/jobs/${jobId}`, {
          signal: controller.signal,
        });
        if (closed) return;
        if (response.status === 404) {
          unavailableJob.current = jobId;
          acceptedJob.current = null;
          setJob(null);
          setReadError("This local proof run is unavailable.");
          return;
        }
        if (!response.ok)
          throw Error("This local proof run could not be read.");
        const data = await response.json();
        if (!closed) {
          accept(data, jobId);
          setReadError(null);
        }
      } catch {
        if (!closed)
          setReadError(
            "The local proof could not be refreshed. Retained records remain visible; reconnecting…",
          );
      } finally {
        clearTimeout(timeout);
        controller = null;
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 500);
    return () => {
      closed = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, [jobId, accept]);
  useEffect(() => {
    const failed = failedDiscardFocus.current;
    if (!failed || failed.jobId !== jobId || busy || !job?.discardError) return;
    const timer = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === document.body || !active?.isConnected)
        discardRetryButton.current?.focus({ preventScroll: true });
      // A still-focused original control, or another control chosen by the
      // person while waiting, keeps its focus. Never take it back later.
      failedDiscardFocus.current = null;
    });
    return () => cancelAnimationFrame(timer);
  }, [jobId, job?.discardError, busy]);
  const advance = async () => {
    const sequence = job?.snapshot?.sequence;
    const expectedId = jobId;
    if (!sequence || !expectedId) return;
    setJob((current) => (current ? { ...current, waiting: false } : null));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/offline/jobs/${jobId}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence }),
      });
      if (!response.ok) {
        const x = await response.json();
        throw Error(x.error);
      }
    } catch (e) {
      if (activeJobId.current !== expectedId) return;
      setError(
        e instanceof Error
          ? e.message
          : "The controlled checkpoint could not advance.",
      );
      // Refresh readiness immediately; an uncertain response may already have
      // released the old checkpoint, so never restore the previous flag.
      try {
        const response = await fetch(`/api/offline/jobs/${jobId}`);
        if (response.ok) {
          const fresh = await response.json();
          accept(fresh, expectedId);
        }
      } catch {
        // The regular saved-state read remains the fallback after connection failure.
      }
    } finally {
      if (activeJobId.current === expectedId) setBusy(false);
    }
  };
  const retryDiscard = async () => {
    const expectedId = jobId;
    if (!expectedId) return;
    const trigger = document.activeElement;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/autonomous/audit/${jobId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw Error();
      accept(
        { jobId: expectedId, deleted: true, discardError: null },
        expectedId,
      );
    } catch {
      if (activeJobId.current === expectedId) {
        failedDiscardFocus.current = { jobId: expectedId, trigger };
        setError("Discard is still incomplete. You can retry it here.");
      }
    } finally {
      if (activeJobId.current === expectedId) setBusy(false);
    }
  };
  const retryStart = async () => {
    if (!jobId || !job?.pendingStart) return;
    const expectedId = jobId;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/offline/jobs/${jobId}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const reply = await response.json();
      if (activeJobId.current !== expectedId) return;
      if (!response.ok) throw Error(reply.error || "The saved Start could not be confirmed.");
      if (reply.jobId !== expectedId) throw Error("The saved Start reply changed.");
      // The normal saved-state poll will read the original run; no new target
      // or client-created identity is supplied by this button.
    } catch (cause) {
      if (activeJobId.current === expectedId)
        setError(cause instanceof Error ? cause.message : "The saved Start could not be confirmed.");
    } finally { if (activeJobId.current === expectedId) setBusy(false); }
  };
  return (
    <div
      className={
        running || report
          ? "h-screen flex flex-col bg-surface"
          : "min-h-screen flex flex-col bg-surface"
      }
    >
      <div
        className="flex-none p-3"
        data-testid="offline-funnel-notice"
        role="region"
        aria-label="Local proof status"
      >
        <CavCallout variant="info" icon="info">
          {publicSites
            ? (history ? "Meta test history · one card per saved run of Testing Account, the same in every browser on this computer. Page counts are saved screens; partial runs remain unscored. Setup attempts that never started a run are not listed. " : "Meta website test · enter your public website and journey below. ") +
              "The existing browser, findings and report are used. Model credits stay within the configured test budget; no Cavioo account is charged. " +
              "Use the Desktop keyboard plan. Stop before a booking, purchase, login or account creation."
            : liveProof
            ? "Local Meta live proof · Meta model calls enabled for the controlled browser run · " +
              "fixed demo plan and demo account. Model credits count toward the private run limit; " +
              "no Cavioo account is charged. The browser view refreshes live; " +
              "screen deletion remains unavailable in this proof."
            : "Local offline proof · actual controlled browser actions · fixed demo plan and " +
              "saved analysis responses · demo account · no model credits or billing charges. " +
              "The browser view refreshes live; screen deletion remains unavailable in this proof."}
          {!jobId && !publicSites && (
            <div className="mt-2 break-all">
              <span>Controlled URL: </span>
              <span data-testid="controlled-url">{bootstrap.url}</span>
              <br />
              <span>Journey: </span>
              <span data-testid="controlled-goal">{bootstrap.goal}</span>
            </div>
          )}
          {running && job?.snapshot && (
            <div className="flex flex-wrap items-center gap-3 mt-2">
              <span data-testid="engine-revision">
                Saved revision {job.snapshot.sequence} ·{" "}
                {job.snapshot.captures.length} original screens
              </span>
              {!liveProof && (
                <CavButton
                  size="sm"
                  label="Advance controlled browser"
                  onClick={advance}
                  disabled={busy || !job.waiting}
                />
              )}
            </div>
          )}
          {!jobId && pendingStarts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Unconfirmed saved Starts">
              <span>A previous Start is unconfirmed. Its original instructions are retained.</span>
              {pendingStarts.map((pending) => <CavButton key={pending.jobId} size="sm" className="max-w-full whitespace-normal break-words"
                label={`Open saved Start for ${new URL(pending.url).hostname}`}
                onClick={() => navigate(`/audits/run/${pending.jobId}`)} />)}
            </div>
          )}
          {error && <div role="alert">{error}</div>}
          {readError && <div role="status">{readError}</div>}
          {browserFeed.error && running && (
            <div role="status">{browserFeed.error}</div>
          )}
          {job?.discardError && !job.deleted && (
            <div role="alert" className="mt-2">
              <p>{job.discardError}</p>
              <CavButton
                ref={discardRetryButton}
                label="Retry discarding run"
                onClick={retryDiscard}
                disabled={busy}
                title={busy ? "Waiting for discard confirmation." : undefined}
              />
            </div>
          )}
        </CavCallout>
      </div>
      {history ? (
        <>
          <DarkReady />
          <AuditListClient mainId="main-content" loadDetails />
        </>
      ) : report ? (
        job?.snapshot && !job.deleted ? (
          <AuditReportClient
            key={`${jobId}:${job.keyboardWarning ? "keyboard-unavailable" : "keyboard-readable"}`}
            session={metaWalkSession(
              job.snapshot,
              jobId!,
              job.keyboard,
              job.keyboardWarning,
              job.assessment,
              job.assessmentWarning,
            )}
          />
        ) : (
          <main id="main-content" tabIndex={-1} className="p-6">
            <CavCallout variant="info" icon="info">
              {job?.deleted
                ? "This proof run was discarded. Its report and screenshots are unavailable."
                : (readError ?? error ?? "Loading the original local proof…")}
            </CavCallout>
          </main>
        )
      ) : running && job?.pendingStart ? (
        <>
          <EditorialTopNav />
          <main id="main-content" tabIndex={-1} className="p-4 md:p-6 min-w-0">
            <CavCallout variant="info" icon="info">
              <p>Start is unconfirmed here. The engine may already have received it. These are the original saved instructions; retrying uses the same request.</p>
              <p className="mt-2 break-words">{job.pendingStart.goal}</p>
              <ol className="mt-2 list-decimal pl-5 space-y-1">
                {job.pendingStart.steps.map((step) => <li key={step.id} className="break-words">
                  {step.text}{step.optional ? " (optional)" : ""}
                  {step.success && <p>Done when: {step.success}</p>}
                  {step.hint && <p>{step.hint}</p>}
                </li>)}
              </ol>
              <div className="mt-3 flex flex-wrap gap-2">
                <CavButton label="Retry saved Start" onClick={retryStart} disabled={busy || job.discarding}
                  title={job.discarding ? "Finish discarding this saved Start before another action." : busy ? "Waiting for the saved Start reply." : undefined} />
                <CavButton label="Discard saved Start" variant="secondary" onClick={retryDiscard} disabled={busy}
                  title={busy ? "Waiting for discard confirmation." : undefined} />
              </div>
            </CavCallout>
          </main>
        </>
      ) : running ? (
        <>
          <EditorialTopNav />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex flex-col flex-1 min-w-0 min-h-0 relative overflow-hidden"
          >
            <RunProgress
              key={jobId}
              jobId={jobId!}
              viewerId="testing-account"
              capabilities={capabilities}
              browserFeed={browserFeed}
            />
          </main>
          {job?.snapshot && !job.deleted && (
            <ReviewedEnginePins
              snapshot={job.snapshot}
              jobId={jobId!}
              shownFrame={browserFeed.connected ? browserFeed.shown : null}
            />
          )}
        </>
      ) : (
        <>
          <DarkReady />
          <EditorialTopNav />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 min-w-0 relative"
          >
            <BriefScreen />
          </main>
        </>
      )}
      {report && job?.deleted && (
        <CavButton
          label="Return to setup"
          onClick={() => navigate("/audits/new")}
        />
      )}
    </div>
  );
}
fetch("/api/offline/bootstrap")
  .then(async (response) => {
    if (!response.ok) throw Error();
    const bootstrap = await response.json();
    createRoot(document.getElementById("root")!).render(
      <App bootstrap={bootstrap} />,
    );
  })
  .catch(() => {
    document.getElementById("root")!.textContent =
      "The local engine connection is unavailable. No audit was started.";
  });
