import type { StickToBottomState, useStickToBottom } from 'use-stick-to-bottom';

/*
 * The places ConversationView relies on use-stick-to-bottom's mutable state
 * beyond its documented API, kept together so an upgrade has one place to
 * check. Written against use-stick-to-bottom 1.1.6 (pinned by pnpm-lock.yaml).
 * TranscriptWindow.browser.test.tsx (jump to bottom, wheel return, keyboard
 * and scrollbar escapes, switching back, parked trimming) is the upgrade gate.
 */

type StickToBottom = ReturnType<typeof useStickToBottom>;
type ScrollToBottom = StickToBottom['scrollToBottom'];

/**
 * Whether the bottom lock is engaged right now. Reads the live state: the
 * rendered escapedFromLock follows only a manual scroll, never a programmatic
 * jump (the library ignores its own scroll events).
 */
export function isBottomLockEngaged(state: StickToBottomState): boolean {
  return state.isAtBottom && !state.escapedFromLock;
}

/**
 * Calls back if the lock is engaged once the hook has settled the latest
 * scroll; returns a cancel. The hook publishes near-bottom from the scroll
 * event but engages the lock in a 1ms timeout after it, so a render on
 * near-bottom still sees the lock released, and engaging it changes no
 * rendered flag. A later timeout of the same delay runs after the hook's.
 */
export function afterScrollSettles(state: StickToBottomState, callback: () => void): () => void {
  const timer = setTimeout(() => {
    if (isBottomLockEngaged(state)) callback();
  }, 1);
  return () => clearTimeout(timer);
}

const UPWARD_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);

/**
 * Escape the lock synchronously when the reader scrolls up by keyboard or
 * scrollbar, as the hook does for an upward wheel. Otherwise the hook decides
 * in a timeout after the scroll event, and a pending scroll to the bottom (a
 * jump's instant scroll, or one following content growth) runs in the frame
 * between and overrides the reader. Layout and programmatic scrolls come with
 * no such input, and the hook's resize guard covers both while a scrollbar is
 * held, so they still never escape. Not covered: keys while focus is outside
 * the scroller, and touch (the browser cancels the pointer once it pans).
 * Returns the cleanup.
 */
export function escapeOnReaderScroll(
  element: HTMLElement,
  state: StickToBottomState,
  stopScroll: StickToBottom['stopScroll']
): () => void {
  // The scrollbar belongs to the scroller itself; its content is a descendant.
  let holdingScrollbar = false;
  let lastScrollTop = element.scrollTop;
  const onPointerDown = (event: PointerEvent) => {
    holdingScrollbar = event.target === element;
    lastScrollTop = element.scrollTop;
  };
  const onPointerUp = () => {
    holdingScrollbar = false;
  };
  const onScroll = () => {
    if (holdingScrollbar && !state.resizeDifference && element.scrollTop < lastScrollTop) {
      stopScroll();
    }
    lastScrollTop = element.scrollTop;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (
      (UPWARD_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !target.isContentEditable &&
      !target.closest('input, textarea, select') &&
      element.scrollHeight > element.clientHeight
    ) {
      stopScroll();
    }
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  element.addEventListener('scroll', onScroll, { passive: true });
  element.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
    element.removeEventListener('scroll', onScroll);
    element.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * A newly attached scroll container (reopening a session renders a spinner
 * first) starts a fresh scroll baseline, as on first mount. Otherwise the hook
 * compares the old container's last position with this one's first scroll,
 * reads an upward scroll, and releases the bottom lock.
 */
export function resetScrollBaseline(state: StickToBottomState): void {
  state.lastScrollTop = undefined;
  state.ignoreScrollToTop = undefined;
}

/**
 * An explicit return to the bottom (jump button, send, panel activation).
 * scrollToBottom() sets isAtBottom but never clears the escape, so a prior
 * scroll-up would leave the lock half-engaged and the re-pin after late or
 * streamed content would not follow. It also scrolls a frame later while
 * isAtBottom flips now, so land first, synchronously, through the library's
 * own scrollTop setter (which bypasses CSS smooth scrolling and records the
 * position as programmatic). A trim triggered by the flip then anchors at the
 * bottom instead of mid-jump. `initial`/`resize` options do not apply to this
 * explicit call, so ask for `instant`: animated, it springs through history.
 */
export function jumpToBottom(state: StickToBottomState, scrollToBottom: ScrollToBottom): void {
  state.escapedFromLock = false;
  state.scrollTop = state.calculatedTargetScrollTop;
  void scrollToBottom({ animation: 'instant' });
}
