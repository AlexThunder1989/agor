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
 * Watches the scroller for the reader's own scrolls; returns the cleanup.
 * Not the reader's: the hook's own writes (its programmatic-scroll marker: a
 * jump, a follow, a trim's anchoring, all landing at the end), and scrolls
 * under a shrink guard (a trim or collapsed content clamping or anchoring the
 * position). Growth never moves scrollTop up, so a growth guard is no reason
 * to discount a scroll.
 *
 * Reports whether the reader's last scroll left them at the physical end
 * (within 2px), not merely in the hook's 70px near-bottom zone, where its lock
 * engages while they may still be reading. Measured per scroll, not live: a
 * new turn extends the content before the hook follows it.
 *
 * Escapes the lock synchronously when the reader's keyboard or scrollbar input
 * actually moves the scroller up, as the hook does for an upward wheel.
 * Otherwise the hook decides in a timeout after the scroll event, and a
 * pending scroll to the bottom (a jump's, or one following content growth)
 * runs in the frame between and overrides the reader. A key that activates a
 * focused control or scrolls a nested region moves nothing here, so it leaves
 * the lock alone. Not covered: touch, where the browser cancels the pointer
 * once it pans.
 */
export function watchReaderScroll(
  element: HTMLElement,
  state: StickToBottomState,
  stopScroll: StickToBottom['stopScroll'],
  onReaderAtEnd: (atEnd: boolean) => void
): () => void {
  // The scrollbar belongs to the scroller itself; its content is a descendant.
  let holdingScrollbar = false;
  let holdingUpwardKey = false;
  let lastScrollTop = element.scrollTop;
  // Measured from where the input starts: a jump in the same frame coalesces
  // into the input's first scroll event.
  const onPointerDown = (event: PointerEvent) => {
    holdingScrollbar = event.target === element;
    lastScrollTop = element.scrollTop;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    holdingUpwardKey = UPWARD_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey);
    lastScrollTop = element.scrollTop;
  };
  const onPointerUp = () => {
    holdingScrollbar = false;
  };
  const onKeyUp = () => {
    holdingUpwardKey = false;
  };
  const onBlur = () => {
    onPointerUp();
    onKeyUp();
  };
  const onScroll = (event: Event) => {
    // A capture listener also sees nested scrollers' scroll events.
    if (event.target !== element) return;
    const { scrollTop } = element;
    const programmatic = scrollTop === state.ignoreScrollToTop;
    const readerScroll = !programmatic && state.resizeDifference >= 0;
    // The hook wrote since the last event: its landing, even if scroll
    // anchoring then moved it or the reader's input coalesced with it.
    if (state.ignoreScrollToTop !== undefined) onReaderAtEnd(true);
    else if (readerScroll) onReaderAtEnd(state.scrollDifference <= 1);
    if (readerScroll && (holdingScrollbar || holdingUpwardKey) && scrollTop < lastScrollTop) {
      stopScroll();
    }
    lastScrollTop = scrollTop;
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  // Capture runs before the hook's own listener at the target, which clears
  // its programmatic-scroll marker.
  element.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    element.removeEventListener('scroll', onScroll, true);
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
