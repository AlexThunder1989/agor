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

  useEffect(() => {
    const timer = getInitialLoadDebugTimer();
    if (!timer || !initialized || !boardId) return;
    timer.markStage('board-initialized');
    let frame = 0;
    let cancelPaint: (() => void) | undefined;
    let previousViewport = '';
    let stableFrames = 0;
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
        cancelPaint = afterInitialLoadPaintOpportunity(() => timer.surfaceReady('board'));
        return;
      }
      frame = requestAnimationFrame(observe);
    };
    frame = requestAnimationFrame(observe);
    return () => {
      cancelAnimationFrame(frame);
      cancelPaint?.();
    };
  }, [initialized, boardId, instance]);

  return (duration: number) => {
    if (!boardId || !getInitialLoadDebugTimer()) return;
    // React Flow 11 fitView returns a boolean, not a completion promise. Wait
    // out the EXISTING animation, then observe a stable viewport for two frames.
    // This also handles no-motion fits (which emit no onMoveEnd event).
    positioning.current = { boardId, notBefore: performance.now() + duration };
    getInitialLoadDebugTimer()?.markStage('board-initial-position-start');
  };
}
