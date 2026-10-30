import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { LiveRunPreview } from "@/app/audits/new/LiveRunPreview";
import { LiveRunPipeline } from "@/app/audits/new/LiveRunPipeline";
import { LiveRunPagesStrip } from "@/app/audits/new/LiveRunPagesStrip";
import { AuditReportView } from "@/components/audits/report/AuditReportView";
import { FullScreenAnnotationViewer } from "@/components/FullScreenAnnotationViewer";
import { AnnotationPin } from "@/components/AnnotationPin";
import { AnnotationPostit } from "@/components/AnnotationPostit";
import { CavButton } from "@/components/ui/CavButton";
import { CavCallout } from "@/components/ui/CavCallout";
import { CaviooWordmark } from "@/components/brand/CaviooWordmark";
import { advanceMetaReplay, hostSnapshotSchema, metaWalkPins, projectMetaWalk, type HostSnapshot } from "@/lib/metaWalkHost";

/** Proof controls only. No product route, account, live transport or paid work. */
function Proof({ snapshots }: { snapshots: HostSnapshot[] }) {
  const [replay, setReplay] = useState({snapshot:snapshots[0]!, position:0, refusal:null as string | null});
  const {snapshot} = replay;
  const [report, setReport] = useState(false);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [bubbleRect, setBubbleRect] = useState<DOMRect | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const view = projectMetaWalk(snapshot);
  const capture = snapshot.captures.at(-1);
  const pins = capture ? metaWalkPins(snapshot, capture.id, capture.imageHash) : [];
  const bubbleIssue = pins.find((issue) => issue.id === bubble);
  const step = view.steps.find((item) => item.id === screenId);
  useEffect(() => { setOverlay(report ? null : root.current?.querySelector<HTMLElement>('[data-testid="frame-box"]') ?? null); }, [report]);
  const advance = () => {
    setReplay((current) => advanceMetaReplay(current, snapshots));
    setBubble(null);
  };
  const openFinding = (id: string) => { setFocus(id); setScreenId(view.issues.find((issue) => issue.id === id)?.stepId ?? null); };
  return <div ref={root} className="min-h-screen bg-surface text-ink">
    <header className="flex flex-wrap items-center gap-3 p-4 border-b border-rule">
      <CaviooWordmark />
      <CavButton label={report ? "View recorded walk" : "View report"} variant="secondary" onClick={() => {setBubble(null); setReport(!report);}} />
      {!report && <CavButton label="Next saved state" onClick={advance} disabled={replay.position === snapshots.length - 1 || !!replay.refusal} />}
    </header>
    <div className="p-4"><CavCallout variant="info" icon="info">
      Offline compatibility proof · recorded browser screens · saved review examples · no model calls.
      Limited coverage; no score. Real VoiceOver, SAM and live video transport are not established.
      <span data-testid="replay-position"> Saved revision {snapshot.sequence}. Replay position {replay.position + 1} of {snapshots.length}.</span>
    </CavCallout></div>
    {replay.refusal && <div className="px-4" role="alert"><CavCallout variant="error" icon="error">{replay.refusal}</CavCallout></div>}
    {report ? <AuditReportView auditName="Access Walk offline compatibility proof" scope={view.scope}
      synthesis={view.synthesis} rubric={null} steps={view.steps} issues={view.issues} strengths={[]}
      createdByName="Testing Account" capturedAt={snapshot.run.createdAt} analystPicks={new Set()}
      onOpenFinding={openFinding} onOpenStrength={() => {}} onOpenScreen={(id) => {setFocus(null); setScreenId(id);}}
      onViewAllFindings={() => { if(view.issues[0]) openFinding(view.issues[0].id); }}
      onGenerateSynthesis={null} synthesisState="idle" synthesisError={null} /> :
      <main className="flex flex-col md:flex-row min-h-[700px]">
        <LiveRunPipeline progress={view.progress} status="done" />
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
            <div className="flex flex-col flex-1 lg:min-h-0" data-testid="recorded-preview">
              <LiveRunPreview progress={view.progress} status="done" isRunning={false}
                handoffFrame={capture ? {dataUrl: view.progress.screenshotUrl!, width: capture.width, height: capture.height} : null}
                handoffConnected={false} />
            </div>
            <LiveRunPagesStrip screens={view.progress.screens ?? []} tasks={[]} isRunning={false} />
          </div>
        </div>
      </main>}
    {overlay && !report && createPortal(<div className="absolute inset-0 pointer-events-none" data-testid="reviewed-pins">
      {pins.map((issue, pinIndex) => <div className="pointer-events-auto" key={issue.id}>
        <AnnotationPin issue={issue} index={pinIndex} imageRect={null} isDraggingEnabled={false} isHighlighted={bubble === issue.id}
          onClick={() => { setBubbleRect(overlay.getBoundingClientRect()); setBubble(bubble === issue.id ? null : issue.id); }} />

      </div>)}
    </div>, overlay)}
    {bubbleIssue && bubbleRect && !report && createPortal(<div data-testid="reviewed-bubble"
      className="absolute z-50 pointer-events-none" style={{left:bubbleRect.left + window.scrollX,
        top:bubbleRect.top + window.scrollY, width:bubbleRect.width, height:bubbleRect.height}}>
      <div className="pointer-events-auto"><AnnotationPostit issue={bubbleIssue} index={0} isHovered onClose={() => setBubble(null)} /></div>
    </div>, document.body)}
    {step && <FullScreenAnnotationViewer step={{ id: step.id, evidenceId: step.evidenceId,
      showOriginalVariants: step.showOriginalVariants,
      stateLabel: step.stateLabel, captureProfile: step.captureProfile, customTitle: step.customTitle, pageTitle: step.pageTitle,
      url: step.url!, screenshotUrl: step.screenshotUrl,
      screenshotVariants: step.screenshotVariants.map((variant) => ({ ...variant, devicePreset: null })),
      capturedAt: step.capturedAt }}
      issues={view.issues.filter((issue) => issue.stepId === step.id)} strengths={[]}
      focusFindingId={focus} isReadOnly canComment={false} onClose={() => setScreenId(null)} />}
  </div>;
}
fetch("/bundle.json").then(async (response) => {
  if (!response.ok) throw Error("Offline fixture could not be read");
  const bundle: { snapshots: unknown[] } = await response.json();
  const snapshots = bundle.snapshots.map((item) => hostSnapshotSchema.parse(item));
  createRoot(document.getElementById("root")!).render(<Proof snapshots={snapshots} />);
}).catch(() => { document.getElementById("root")!.textContent = "The offline fixture was refused. No audit was started."; });
