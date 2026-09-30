import { useEffect, useRef } from 'react';
import type { Node, ReactFlowInstance } from 'reactflow';
import {
  afterInitialLoadPaintOpportunity,
  getInitialLoadDebugTimer,
} from '../utils/initialLoadDebug';

/** Observe only: never fit, pan, retry positioning, or gate rendering. */
export function useInitialBoardReadiness(
  initialized: boolean,
  boardId: string | undefined,
  expectedNodes: Node[],
  instance: React.RefObject<ReactFlowInstance | null>
) {
  const expected = useRef(expectedNodes);
  expected.current = expectedNodes;
  const positioning = useRef<{ boardId: string; notBefore: number } | null>(null);
  const observer = useRef<{ boardId: string; failed: () => void } | null>(null);

  useEffect(() => {
    const timer = getInitialLoadDebugTimer();
    if (!timer || !initialized || !boardId) return;
    timer.markStage('board-initialized');
    let frame = 0;
    let cancelPaint: (() => void) | undefined;
    let previousViewport = '';
    let stableFrames = 0;
    // Missing measurements/positioning must not leave a diagnostic polling for
    // the lifetime of the canvas. This deadline never retries or moves the view.
    const timeout = setTimeout(() => {
      stop();
      timer.surfaceFailed('board', 'board-readiness-timeout');
    }, 30_000);
    const stop = () => {
      cancelAnimationFrame(frame);
      cancelPaint?.();
      clearTimeout(timeout);
    };
    const unsubscribe = timer.onSettled(stop);
    observer.current = {
      boardId,
      failed: () => {
        stop();
        timer.surfaceFailed('board', 'board-initial-position-failed');
      },
    };
    const observe = () => {
      if (getInitialLoadDebugTimer() !== timer) return;
      const flow = instance.current;
      const nodes = flow?.getNodes() ?? [];
      const expectedIds = new Set(expected.current.map((node) => node.id));
      // Do not confuse the pre-sync empty React Flow store with an empty board,
      // or stale nodes from another board with this board's content.
      const present =
        nodes.length === expectedIds.size && nodes.every((node) => expectedIds.has(node.id));
      const empty = !!flow && present && expectedIds.size === 0;
      const positioned =
        positioning.current?.boardId === boardId &&
        performance.now() >= positioning.current.notBefore;
      const viewport = JSON.stringify(flow?.getViewport());
      stableFrames = viewport === previousViewport ? stableFrames + 1 : 0;
      previousViewport = viewport;
      if (
        present &&
        (empty ||
          (positioned && stableFrames >= 2 && nodes.every((node) => node.width && node.height)))
      ) {
        timer.markStage('board-initial-position-settled');
        timer.markStage('board-ready-commit');
        cancelPaint = afterInitialLoadPaintOpportunity(() => {
          stop();
          timer.surfaceReady('board');
        });
        return;
      }
      frame = requestAnimationFrame(observe);
    };
    frame = requestAnimationFrame(observe);
    return () => {
      stop();
      unsubscribe();
      observer.current = null;
      positioning.current = null;
    };
  }, [initialized, boardId, instance]);

  return (duration: number, positioned = true) => {
    if (!boardId || !getInitialLoadDebugTimer()) return;
    if (!positioned) {
      if (observer.current?.boardId === boardId) observer.current.failed();
      return;
    }
    // React Flow 11 fitView returns a boolean, not a completion promise. Wait
    // out the EXISTING animation, then observe a stable viewport for two frames.
    // This also handles no-motion fits (which emit no onMoveEnd event).
    positioning.current = { boardId, notBefore: performance.now() + duration };
    getInitialLoadDebugTimer()?.markStage('board-initial-position-start');
  };
}
