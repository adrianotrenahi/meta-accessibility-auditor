import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnnotationPin } from "@/components/AnnotationPin";
import { AnnotationPostit } from "@/components/AnnotationPostit";
import {
  metaWalkPins,
  projectMetaWalk,
  type HostSnapshot,
} from "@/lib/metaWalkHost";
import {
  liveEvidenceIdentity,
  matchingLiveCapture,
  type MetaLiveFrame,
} from "@/lib/metaLiveFrame";

/** Exact rendered-image matching, even when the run's slower picture poll lags. */
export function ReviewedEnginePins({
  snapshot,
  jobId,
  shownFrame = null,
}: {
  snapshot: HostSnapshot;
  jobId: string;
  shownFrame?: MetaLiveFrame | null;
}) {
  const capture = shownFrame
      ? matchingLiveCapture(snapshot, shownFrame)
      : snapshot.captures.at(-1),
    image = capture?.imageAvailable
      ? `/api/offline/jobs/${jobId}/assets/${capture.imageHash}.png`
      : null;
  const pixelWidth = capture?.width,
    pixelHeight = capture?.height;
  const [placement, setPlacement] = useState<{
    holder: HTMLElement;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const holder = placement?.holder ?? null;
  const [opened, setOpened] = useState<string | null>(null),
    [rect, setRect] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const view = projectMetaWalk(snapshot, {
    sessionId: jobId,
    evidenceBase: `/api/offline/jobs/${jobId}/assets`,
  });
  const allowed = capture
    ? new Set(
        metaWalkPins(snapshot, capture.id, capture.imageHash).map((p) => p.id),
      )
    : new Set<string>();
  const pins = holder ? view.issues.filter((p) => allowed.has(p.id)) : [],
    bubble = pins.find((p) => p.id === opened);
  useEffect(() => {
    setOpened(null);
  }, [capture?.id, snapshot.sequence]);
  useLayoutEffect(() => {
    let watched: HTMLElement | null = null;
    const resize = new ResizeObserver(() => match());
    const match = () => {
      const box = document.querySelector<HTMLElement>(
        '[data-testid="frame-box"]',
      );
      const img = box?.querySelector<HTMLImageElement>("img");
      const canvas = box?.querySelector<HTMLCanvasElement>("canvas");
      const watchedElement = canvas ?? img ?? null;
      if (watchedElement !== watched) {
        resize.disconnect();
        watched = watchedElement;
        if (watched) resize.observe(watched);
      }
      const r = watched?.getBoundingClientRect();
      const exactCanvas = !!(
        canvas &&
        shownFrame &&
        capture &&
        pixelWidth &&
        pixelHeight &&
        r?.width &&
        r.height &&
        canvas.dataset.displayEvidence === liveEvidenceIdentity(shownFrame) &&
        canvas.width === pixelWidth &&
        canvas.height === pixelHeight
      );
      const exact = !!(
        !canvas &&
        image &&
        pixelWidth &&
        pixelHeight &&
        img?.complete &&
        img.naturalWidth === pixelWidth &&
        img.naturalHeight === pixelHeight &&
        img.currentSrc === new URL(image, location.href).href &&
        r &&
        Math.abs(r.width - (r.height * pixelWidth) / pixelHeight) <= 1
      );
      let next: typeof placement = null;
      if (
        exactCanvas &&
        canvas?.parentElement &&
        r &&
        pixelWidth &&
        pixelHeight
      ) {
        const scale = Math.min(r.width / pixelWidth, r.height / pixelHeight);
        next = {
          holder: canvas.parentElement,
          left: (r.width - pixelWidth * scale) / 2,
          top: (r.height - pixelHeight * scale) / 2,
          width: pixelWidth * scale,
          height: pixelHeight * scale,
        };
      } else if (exact && box && r)
        next = {
          holder: box,
          left: 0,
          top: 0,
          width: r.width,
          height: r.height,
        };
      setPlacement((previous) =>
        previous?.holder === next?.holder &&
        previous?.left === next?.left &&
        previous?.top === next?.top &&
        previous?.width === next?.width &&
        previous?.height === next?.height
          ? previous
          : next,
      );
    };
    const observer = new MutationObserver(match);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-display-evidence", "width", "height"],
    });
    document.addEventListener("load", match, true);
    window.addEventListener("resize", match);
    match();
    return () => {
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener("load", match, true);
      window.removeEventListener("resize", match);
    };
  }, [pixelWidth, pixelHeight, image, capture, shownFrame]);
  const close = useCallback(() => {
    setOpened(null);
    if (trigger.current?.isConnected) trigger.current.focus();
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [close]);
  return (
    <>
      {holder &&
        createPortal(
          <div
            className="absolute pointer-events-none"
            data-testid="engine-reviewed-pins"
            style={
              placement
                ? {
                    left: placement.left,
                    top: placement.top,
                    width: placement.width,
                    height: placement.height,
                  }
                : undefined
            }
          >
            {pins.map((issue, index) => (
              <div className="pointer-events-auto" key={issue.id}>
                <AnnotationPin
                  issue={issue}
                  index={index}
                  imageRect={null}
                  isDraggingEnabled={false}
                  isHighlighted={opened === issue.id}
                  onClick={() => {
                    trigger.current = document.activeElement as HTMLElement;
                    setRect(
                      holder
                        .querySelector('[data-testid="engine-reviewed-pins"]')
                        ?.getBoundingClientRect() ??
                        holder.getBoundingClientRect(),
                    );
                    setOpened(opened === issue.id ? null : issue.id);
                  }}
                />
              </div>
            ))}
          </div>,
          holder,
        )}
      {bubble &&
        rect &&
        createPortal(
          <div
            data-testid="engine-reviewed-bubble"
            className="absolute z-50 pointer-events-none"
            style={{
              left: rect.left + scrollX,
              top: rect.top + scrollY,
              width: rect.width,
              height: rect.height,
            }}
          >
            <div className="pointer-events-auto">
              <AnnotationPostit
                issue={bubble}
                index={0}
                isHovered
                onClose={close}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
