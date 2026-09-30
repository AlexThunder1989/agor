import { useEffect } from 'react';
import {
  afterInitialLoadPaintOpportunity,
  getInitialLoadDebugTimer,
} from '../utils/initialLoadDebug';

/** Commit + double-rAF proxy. This does not measure browser paint or interactivity. */
export function useInitialLoadReadiness(
  surface: 'home' | 'board' | 'conversation',
  ready: boolean,
  failed = false
) {
  useEffect(() => {
    const timer = getInitialLoadDebugTimer();
    if (!timer) return;
    if (failed) {
      timer.markStage(`${surface}-error`);
      timer.finish('error');
      return;
    }
    if (!ready) return;
    timer.markStage(`${surface}-ready-commit`);
    return afterInitialLoadPaintOpportunity(() => timer.surfaceReady(surface));
  }, [surface, ready, failed]);
}
