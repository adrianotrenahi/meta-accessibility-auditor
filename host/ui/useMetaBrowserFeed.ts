import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandoffFrame } from "@/app/audits/new/useHandoffSocket";
import {
  livePicture,
  metaLiveFrameSchema,
  type MetaLiveFrame,
} from "@/lib/metaLiveFrame";

/** Demand-paced, view-only pictures. Reads never start or advance a run. */
export function useMetaBrowserFeed(
  jobId: string | null,
  runId: string | null,
  active: boolean,
) {
  const [frame, setFrame] = useState<MetaLiveFrame | null>(null);
  const [shown, setShown] = useState<MetaLiveFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<MetaLiveFrame | null>(null);
  const drawn = useRef<(redraw?: boolean) => void>(() => {});
  useEffect(() => {
    latest.current = null;
    setFrame(null);
    setShown(null);
    setConnected(false);
    setError(null);
    if (!jobId || !runId || !active) return;
    let closed = false,
      busy = false,
      lastSequence = 0;
    let lastFrame: MetaLiveFrame | null = null,
      needsRedraw = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!closed)
        timer = setTimeout(() => {
          timer = undefined;
          void read();
        }, ms);
    };
    const read = async () => {
      if (closed || document.hidden) return;
      if (busy) {
        schedule(250);
        return;
      }
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 6000);
      try {
        const response = await fetch(`/api/offline/jobs/${jobId}/frame`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw Error(
            "Live view reconnecting. The latest saved screenshot is shown.",
          );
        const value = metaLiveFrameSchema.parse(await response.json());
        if (
          value.runId !== runId ||
          Date.now() - Date.parse(value.capturedAt) > 5000 ||
          Date.parse(value.capturedAt) > Date.now() + 1000
        )
          throw Error("The live picture is no longer current. Reconnecting.");
        if (closed || document.hidden) return;
        if (
          value.sequence < lastSequence ||
          (value.sequence === lastSequence && !needsRedraw)
        ) {
          schedule(250);
          return;
        }
        if (
          value.sequence === lastSequence &&
          JSON.stringify(value) !== JSON.stringify(lastFrame)
        )
          throw Error("A live picture changed without a new identity.");
        lastSequence = value.sequence;
        lastFrame = value;
        needsRedraw = false;
        latest.current = value;
        setError(null);
        setConnected(true);
        setFrame(value);
        schedule(1000); // A picture not drawn must not stall reconnection forever.
      } catch {
        if (closed || document.hidden) return;
        needsRedraw = true;
        latest.current = null;
        setShown(null);
        setFrame(null);
        setConnected(false);
        setError(
          "Live view reconnecting. The latest saved screenshot is shown.",
        );
        schedule(1000);
      } finally {
        clearTimeout(timeout);
        busy = false;
      }
    };
    drawn.current = (redraw = false) => {
      if (redraw) needsRedraw = true;
      schedule(250);
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        controller?.abort();
        needsRedraw = true;
        latest.current = null;
        setConnected(false);
        setShown(null);
      } else schedule(0);
    };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => {
      closed = true;
      clearTimeout(timer);
      controller?.abort();
      drawn.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [jobId, runId, active]);
  const frameShown = useCallback((picture: HandoffFrame | null) => {
    if (!picture) {
      setShown(null);
      setFrame(null);
      setConnected(false);
      setError("Live view reconnecting. The latest saved screenshot is shown.");
      latest.current = null;
      drawn.current(true);
      return;
    }
    const value = latest.current;
    if (
      !value ||
      picture.identity !== `${value.runId}:${value.sequence}` ||
      picture.dataUrl !== livePicture(value).dataUrl
    )
      return;
    setShown(value);
    drawn.current();
  }, []);
  const picture = useMemo(() => (frame ? livePicture(frame) : null), [frame]);
  const current = active && frame?.runId === runId && connected;
  return {
    frame: current ? picture : null,
    connected: current,
    error: active ? error : null,
    frameShown,
    shown: current && shown?.runId === runId ? shown : null,
  };
}
