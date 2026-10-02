'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './CursorTroupe.module.css';

/**
 * PROTOTYPE (behind a flag): three cursors (Maya, Ari, and Sam in the code;
 * unnamed on screen) follow the reader down the home page and act out each
 * section's point. A director picks the section on stage (sections mark
 * themselves with data-troupe-section) and plays its beat once.
 *
 * Positions live in page coordinates and every target is re-read from the
 * page each frame (an element, or a text range such as one word or one
 * glyph's counter), so cursors stay locked to what they're touching while the
 * page scrolls. They idle at two-thirds size and grow to full size to do
 * things; gestures are motion only. Beats can also nudge the page itself:
 * light a hover state, or drive an element (the board panel they haul on
 * screen). Scrolling back up finds them parked where each beat ended; once
 * they've left at the final CTA they stay gone. Clicking the hero's
 * "Multiplayer AI" pill starts the whole show again. Shown in dev, or after
 * visiting with `?cursors` once; never under reduced motion or on touch.
 */

const ENABLED_KEY = 'agor-cursor-troupe';

const CAST = [
  { name: 'Maya', color: '#f5a3c7', hz: 2.1, extra: false },
  { name: 'Ari', color: '#6fdcf0', hz: 1.8, extra: false },
  { name: 'Sam', color: '#f2d27a', hz: 1.55, extra: false },
  // Guests who only join the governance ring.
  { name: 'Lee', color: '#b9f18c', hz: 1.9, extra: true },
  { name: 'Kit', color: '#c3a6ff', hz: 1.7, extra: true },
  { name: 'Rho', color: '#ff9f7a', hz: 2.0, extra: true },
] as const;

const SECTIONS = [
  'hero',
  'problem',
  'work-together',
  'board',
  'teammates',
  'command-center',
  'roster',
  'governance',
  'final',
] as const;
type SectionId = (typeof SECTIONS)[number];

interface RectLike {
  getBoundingClientRect(): DOMRect;
}
type Anchor = (root: HTMLElement) => Element | RectLike | null | undefined;
type Gesture = 'wave' | 'shrug' | 'look' | 'jump' | 'heave' | 'click';

interface Mark {
  at: number;
  anchor: Anchor;
  /** Offset as a fraction of the anchor's size from its center (-0.5..0.5). */
  fx?: number;
  fy?: number;
  dx?: number;
  dy?: number;
  /** Follow stiffly (it's holding or riding the thing). */
  lock?: boolean;
  /** Turn to point at this anchor's center. */
  point?: Anchor;
  /** Circle the target point; squash < 1 flattens it into an ellipse. */
  orbit?: { r: number; speed: number; phase: number; squash?: number };
  /** Size while at this mark (overrides idle/busy sizing). */
  size?: number;
  /** A small nervous jitter. */
  tremble?: boolean;
}

interface Part {
  marks: Mark[];
  cues?: Array<{ at: number; gesture: Gesture }>;
  /** Hidden until this time. */
  appear?: number;
  /** Fades out from this time and stays gone. */
  vanish?: number;
  /** Keep the last position when the anchor goes away (instead of fading). */
  hold?: boolean;
  /** Extra windows (beat seconds) when this cursor is at work. */
  busy?: Array<[number, number]>;
  /** Read a press from the anchor's data-pressed (the demo's own clicks). */
  pressFromAnchor?: boolean;
}

interface Beat {
  delay: number;
  /** Is this section on stage, given its rect, the viewport height, and root? */
  active: (rect: DOMRect, vh: number, root: HTMLElement) => boolean;
  /** Hide the cursors behind this rect (a hole in the layer) until `until`. */
  mask?: { anchor: Anchor; until: number };
  /** Show the cursors only inside this ellipse, from `from` on. */
  clip?: { anchor: Anchor; from: number };
  /** One part per cast member who's in this beat. */
  parts: Part[];
  /** One-shot side effects on the page, e.g. lighting a hover state. */
  events?: Array<{ at: number; run: (root: HTMLElement) => void }>;
  /** Drive an element: 'before' (not reached yet), 'play' (with t), 'done'. */
  drive?: (root: HTMLElement, phase: 'before' | 'play' | 'done', t: number) => void;
  /** Sets a data attribute on <html> while on stage. */
  htmlFlag?: string;
}

const q =
  (selector: string): Anchor =>
  (root) =>
    root.querySelector(selector);
const nth =
  (selector: string, index: number): Anchor =>
  (root) =>
    root.querySelectorAll(selector)[index];
const at = (x: number, y: number): RectLike => ({
  getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
});

/** A Range around `text` inside `el` (or one character of it). */
function textRange(el: Element | null | undefined, text: string, char?: number): Range | null {
  if (!el) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.textContent?.indexOf(text) ?? -1;
    if (index >= 0) {
      const range = document.createRange();
      const start = index + (char ?? 0);
      range.setStart(node, start);
      range.setEnd(node, char === undefined ? index + text.length : start + 1);
      return range;
    }
  }
  return null;
}

let measure: CanvasRenderingContext2D | null = null;
/** The counter (the hole) of a glyph like "o", from its font metrics. */
function counterRect(range: Range | null): DOMRect | null {
  const parent = range?.startContainer.parentElement;
  if (!range || !parent) return null;
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  const cs = getComputedStyle(parent);
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = measure.measureText(range.toString());
  const box = range.getBoundingClientRect();
  const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const baseline = box.top + (m.fontBoundingBoxAscent * box.height) / content;
  const inkTop = baseline - m.actualBoundingBoxAscent;
  const inkBottom = baseline + m.actualBoundingBoxDescent;
  const inkLeft = box.left - m.actualBoundingBoxLeft;
  const inkRight = box.left + m.actualBoundingBoxRight;
  // The stroke of a semibold "o" eats roughly a fifth of it on each side.
  const sw = (inkRight - inkLeft) * 0.22;
  const sh = (inkBottom - inkTop) * 0.2;
  return new DOMRect(
    inkLeft + sw,
    inkTop + sh,
    inkRight - inkLeft - 2 * sw,
    inkBottom - inkTop - 2 * sh
  );
}

const centerBand = (r: DOMRect, vh: number) => r.top < vh * 0.6 && r.bottom > vh * 0.4;

const pill = q('[class*="homeBadge"]');
const ROW_ITEM = 'a[class*="homeRowItem"]';
const rowItem = (i: number) => nth(ROW_ITEM, i);
const team: Anchor = (root) => textRange(root.querySelector('[class*="homeSub"]'), 'team');
const siloO: Anchor = (root) => {
  const silo = [...root.querySelectorAll('h2 span')].find((s) => s.textContent?.trim() === 'silo');
  const rect = counterRect(textRange(silo, 'silo', 3));
  return rect ? { getBoundingClientRect: () => rect } : null;
};
const demoCursor = (i: number) => q(`[data-troupe-cursor="${i}"]`);
const boardPanel = q('[data-troupe="board-panel"]');
const RING_NODE = 'a[class*="ringNode"]';
const ringNode = (i: number) => nth(RING_NODE, i);
const ringHub = q('[class*="ringHub"]');
const LINKED_BLIP = 'a[class*="radarBlip"]';
const blip = (i: number) => nth(LINKED_BLIP, i);
const rosterLink = q('a[href="/agent-roster"]');
const ccHeading = q('h2');
const confidence: Anchor = (root) => textRange(root.querySelector('h2'), 'confidence');
/** Where the governance ring spins: just past the end of "confidence". */
const spinCenter: Anchor = (root) => {
  const r = confidence(root)?.getBoundingClientRect();
  return r ? at(r.right + 54, r.top + r.height * 0.55) : null;
};
/** Where the governance guests enter from: left, bottom, right of the view. */
const offstage =
  (side: number): Anchor =>
  (root) => {
    const r = spinCenter(root)?.getBoundingClientRect();
    if (!r) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return side === 0 ? at(-60, r.top) : side === 1 ? at(r.left, h + 60) : at(w + 60, r.top);
  };
const together = q('[data-troupe="together"]');
const ctaButton = (i: number) => nth('[class*="heroActions"] > *', i);

const hover = (el?: Element | RectLike | null) =>
  el instanceof Element &&
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
const unhover = (el?: Element | RectLike | null) =>
  el instanceof Element &&
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
/** CSS :hover can't be faked; these rows style [data-troupe-hover] the same. */
const lightRow = (root: HTMLElement, index: number | null) => {
  root.querySelectorAll(ROW_ITEM).forEach((item, i) => {
    item.toggleAttribute('data-troupe-hover', i === index);
  });
};

// Board: the panel is hauled in from the right in three heaves.
const BOARD_PULLS: Array<[number, number, number, number]> = [
  [1.55, 2.15, 0, 0.3],
  [2.55, 3.15, 0.3, 0.62],
  [3.55, 4.5, 0.62, 1],
];
function boardProgress(t: number): number {
  let p = 0;
  for (const [a, b, from, to] of BOARD_PULLS) {
    if (t >= b) p = to;
    else if (t > a) p = from + (to - from) * (1 - (1 - (t - a) / (b - a)) ** 3);
  }
  return p;
}
const boardOffsets = new WeakMap<Element, number>();
function driveBoard(root: HTMLElement, phase: 'before' | 'play' | 'done', t: number) {
  const panel = boardPanel(root) as HTMLElement | null;
  if (!panel) return;
  if (phase === 'done') {
    if (boardOffsets.has(panel)) {
      panel.style.transform = '';
      boardOffsets.delete(panel);
    }
    return;
  }
  const applied = boardOffsets.get(panel) ?? 0;
  const baseLeft = panel.getBoundingClientRect().left - applied;
  // Peek ~70px of the panel's left edge in from the viewport's right edge.
  const start = Math.max(0, window.innerWidth - 70 - baseLeft);
  const offset = start * (1 - (phase === 'play' ? boardProgress(t) : 0));
  boardOffsets.set(panel, offset);
  panel.style.transform = offset ? `translateX(${offset.toFixed(1)}px)` : '';
}

const ROW_SWEEP = [0, 1, 2, 3, 4].map((k) => 1.4 + k * 0.38);
const HERO_GATHER = ROW_SWEEP[4] + 0.6;

const BEATS: Record<SectionId, Beat> = {
  // Out from behind the Multiplayer AI pill. Ari sweeps the landing-page row
  // along the bottom, lighting each link; then all three gather under "team"
  // ("your whole team can see") and do the wave.
  hero: {
    delay: 0.4,
    active: (r, vh) => r.bottom > vh * 0.45,
    mask: { anchor: pill, until: 1.4 },
    parts: [0, 1, 2].map((i) => ({
      appear: i * 0.25,
      marks: [
        { at: 0, anchor: pill },
        { at: 0.15 + i * 0.25, anchor: pill, fx: (i - 1) * 0.5, dx: (i - 1) * 36, dy: 34 },
        ...(i === 1
          ? ROW_SWEEP.map((when, k) => ({ at: when, anchor: rowItem(k), fx: -0.3, fy: -0.2 }))
          : []),
        {
          at: i === 1 ? HERO_GATHER : 1.6 + i * 0.2,
          anchor: team,
          fy: 0.5,
          dx: (i - 1) * 26,
          dy: 10,
        },
      ],
      cues: [
        { at: 0.9 + i * 0.25, gesture: 'look' as const },
        { at: HERO_GATHER + 1.0 + i * 0.15, gesture: 'jump' as const },
        { at: HERO_GATHER + 1.8 + i * 0.15, gesture: 'jump' as const },
      ],
      busy: i === 1 ? [[1.2, HERO_GATHER + 1]] : [],
    })),
    events: [
      ...ROW_SWEEP.map((when, k) => ({
        at: when + 0.15,
        run: (root: HTMLElement) => lightRow(root, k),
      })),
      { at: HERO_GATHER + 0.2, run: (root: HTMLElement) => lightRow(root, null) },
    ],
  },
  // Siloed: they squeeze into the counter of the "o" in "silo" and tremble
  // there, shown only inside it.
  problem: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.55 && r.bottom > vh * 0.5,
    clip: { anchor: siloO, from: 1.0 },
    parts: [
      // Tip positions; each arrow hangs down and right of its tip.
      [-0.38, -0.36],
      [-0.06, -0.3],
      [-0.3, -0.04],
    ].map(([fx, fy]) => ({
      marks: [
        { at: 0, anchor: siloO, dy: -60 },
        { at: 0.2, anchor: siloO, fx, fy, size: 0.42 },
        { at: 1.0, anchor: siloO, fx, fy, size: 0.42, lock: true, tremble: true },
      ],
    })),
  },
  // The demo's Maya, Ari, and Sam are these three: follow their markers
  // (the demo hides its own while we're here) and press when they press.
  'work-together': {
    delay: 0,
    active: (r, vh) => r.top < vh * 0.7 && r.bottom > vh * 0.3,
    htmlFlag: 'data-troupe-wt',
    parts: [0, 1, 2].map((i) => ({
      marks: [{ at: 0, anchor: demoCursor(i), fx: -0.5, fy: -0.5, dx: 2, dy: 1, lock: true }],
      hold: true,
      pressFromAnchor: true,
      busy: [[0, 30]],
    })),
  },
  // Three heaves to haul the media panel on screen from the right.
  board: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.65 && r.bottom > vh * 0.35,
    drive: driveBoard,
    parts: [-0.28, 0, 0.28].map((fy, i) => ({
      marks: [
        { at: 0, anchor: boardPanel, fx: -0.5, fy, dx: 16 },
        { at: 1.1, anchor: boardPanel, fx: -0.5, fy, dx: 16, lock: true },
        { at: 4.8, anchor: boardPanel, fx: -0.42 + i * 0.06, fy: 0.5, dy: 26 },
      ],
      cues: BOARD_PULLS.map(([a]) => ({ at: a - 0.3, gesture: 'heave' as const })),
      busy: [[1.0, 4.7]],
    })),
  },
  // Ari laps the ring, lighting each node; then all three point at Shared
  // ownership: the team owns it.
  teammates: {
    delay: 0.3,
    active: centerBand,
    parts: [
      {
        marks: [
          { at: 0, anchor: ringHub, fx: -0.32, fy: 0.1 },
          { at: 3.2, anchor: ringNode(0), dx: -62, dy: 56, point: ringNode(0) },
        ],
        cues: [{ at: 1.4, gesture: 'look' }],
      },
      {
        marks: [
          ...[1, 2, 3, 4, 5, 6, 0].map((n, k) => ({
            at: 0.3 + 0.34 * k,
            anchor: ringNode(n),
            fx: 0.18,
            fy: 0.22,
          })),
          { at: 3.3, anchor: ringNode(0), dy: 86, point: ringNode(0) },
        ],
        busy: [[0.2, 4.4]],
      },
      {
        marks: [
          { at: 0, anchor: ringHub, fx: 0.32, fy: 0.1 },
          { at: 3.4, anchor: ringNode(0), dx: 62, dy: 56, point: ringNode(0) },
        ],
        cues: [{ at: 1.9, gesture: 'look' }],
      },
    ],
    events: [1, 2, 3, 4, 5, 6, 0].map((n, k) => ({
      at: 0.45 + 0.34 * k,
      run: (root: HTMLElement) => hover(ringNode(n)(root)),
    })),
  },
  // Not much to do here yet (the section is getting a redesign): they take
  // their seats beside the heading and look the place over.
  'command-center': {
    delay: 0.3,
    active: centerBand,
    parts: [0, 1, 2].map((i) => ({
      marks: [{ at: 0, anchor: ccHeading, fx: 0.5, dx: 40 + i * 34, fy: -0.2 + i * 0.25 }],
      cues: [{ at: 1.2 + i * 0.5, gesture: 'look' as const }],
    })),
  },
  // Scan the radar, popping a few teammates' cards, then line up under the
  // roster link and do the wave, twice.
  roster: {
    delay: 0.3,
    active: centerBand,
    parts: [0, 1, 2].map((i) => ({
      marks: [
        { at: 0.3 + i * 0.6, anchor: blip(i), fx: 0.18, fy: -0.05 },
        ...(i < 2 ? [{ at: 2.3 + i * 0.6, anchor: blip(i + 3), fx: 0.18, fy: -0.05 }] : []),
        { at: 4.0, anchor: rosterLink, fx: -0.25 + i * 0.25, fy: 0.5, dy: 22 },
      ],
      cues: [
        { at: 5.0 + i * 0.16, gesture: 'jump' as const },
        { at: 5.9 + i * 0.16, gesture: 'jump' as const },
      ],
      busy: [[0, 6.8]],
    })),
    events: [0, 1, 2, 3, 4].map((k) => ({
      at: 0.7 + k * 0.6 + (k > 2 ? 0.2 : 0),
      run: (root: HTMLElement) => {
        if (k > 0) unhover(blip(k - 1)(root));
        hover(blip(k)(root));
      },
    })),
  },
  // Confidence: three guests arrive from off screen, all six form a ring
  // pointing inward beside "confidence", and turn slowly like a spinner. The
  // guests leave when the reader moves on.
  governance: {
    delay: 0.2,
    active: centerBand,
    parts: [0, 1, 2, 3, 4, 5].map((k) => {
      const guest = k >= 3;
      return {
        marks: [
          guest
            ? { at: 0, anchor: offstage(k - 3) }
            : { at: 0, anchor: spinCenter, dx: (k - 1) * 30, dy: -60 },
          {
            at: guest ? 0.4 + (k - 3) * 0.2 : 0.6,
            anchor: spinCenter,
            orbit: { r: 38, speed: 0.55, phase: (k * Math.PI) / 3, squash: 1 },
            point: spinCenter,
          },
        ],
        busy: [[0, 60]],
      };
    }),
  },
  // Ease in to "together", a little orbit dance around it, then each clicks a
  // CTA and they're off (for good, until the pill brings them back).
  final: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.55 && r.bottom > vh * 0.3,
    parts: [0, 1, 2].map((i) => ({
      marks: [
        { at: 0, anchor: together, dx: (i - 1) * 60, dy: 70 },
        { at: 0.9, anchor: together, orbit: { r: 74, speed: 2.6, phase: (i * 2 * Math.PI) / 3 } },
        { at: 3.7 + i * 0.2, anchor: ctaButton(i), fx: 0.12, fy: 0.15 },
      ],
      cues: [{ at: 4.7 + i * 0.18, gesture: 'click' as const }],
      busy: [[0.6, 5.6]],
      vanish: 5.8 + i * 0.1,
    })),
  },
};
/** Once the final beat gets this far, the show is over. */
const FINAL_EXIT = 6.2;

const GESTURE_SECONDS: Record<Gesture, number> = {
  wave: 0.9,
  shrug: 0.7,
  look: 1.0,
  jump: 0.5,
  heave: 0.9,
  click: 0.8,
};

/** Offset (px), tilt (deg), and press for a gesture `u` (0..1) of the way through. */
function gestureAt(
  gesture: Gesture,
  u: number
): { ox: number; oy: number; rot: number; press?: boolean } {
  const fade = 1 - u;
  switch (gesture) {
    case 'wave':
      return {
        ox: Math.sin(u * Math.PI * 6) * 7 * fade,
        oy: 0,
        rot: Math.sin(u * Math.PI * 6) * 12 * fade,
      };
    case 'shrug':
      return { ox: 0, oy: -Math.abs(Math.sin(u * Math.PI * 2)) * 7, rot: 0 };
    case 'look':
      return { ox: 0, oy: 0, rot: -Math.sin(u * Math.PI) * 18 };
    case 'jump':
      return { ox: 0, oy: -Math.sin(u * Math.PI) * 18, rot: 0 };
    case 'heave': {
      // Lean back (right), then yank left with the pull, then recover.
      const ox = u < 0.3 ? 9 * (u / 0.3) : u < 0.55 ? 9 - 23 * ((u - 0.3) / 0.25) : -14 * fade;
      return { ox, oy: Math.sin(u * Math.PI) * 3, rot: u < 0.3 ? 8 * (u / 0.3) : 0 };
    }
    case 'click':
      return { ox: 0, oy: 0, rot: 0, press: u < 0.25 };
  }
}

/** The arrow points up and left: from its body toward the tip is about -125°. */
const ARROW_ANGLE = -125;

const IDLE_SCALE = 0.66;
const MOVE_SECONDS = 1.1;

function isBusy(part: Part, t: number): boolean {
  const pad = 0.25;
  const within = (a: number, b: number) => t >= a - pad && t < b + pad;
  return (
    (part.cues ?? []).some((cue) => within(cue.at, cue.at + GESTURE_SECONDS[cue.gesture])) ||
    part.marks.slice(1).some((mark) => within(mark.at, mark.at + MOVE_SECONDS)) ||
    (part.busy ?? []).some(([a, b]) => within(a, b))
  );
}

interface CursorState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  opacity: number;
  size: number;
}

export function CursorTroupe() {
  const [enabled, setEnabled] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const cursorRefs = useRef<Array<HTMLDivElement | null>>([]);
  const ringRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).has('cursors')) {
        localStorage.setItem(ENABLED_KEY, '1');
      }
    } catch {
      // Storage blocked: dev still shows it.
    }
    let flagged = process.env.NODE_ENV === 'development';
    try {
      flagged ||= localStorage.getItem(ENABLED_KEY) === '1';
    } catch {}
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setEnabled(flagged && fine && !calm);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const states: CursorState[] = CAST.map(() => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      opacity: 0,
      size: IDLE_SCALE,
    }));
    const played = new Set<SectionId>();
    const fired = new Set<string>();
    let active: SectionId | null = null;
    let since = performance.now();
    let last = since;
    let finished = false;
    let raf = 0;

    const sectionRoot = (id: SectionId) =>
      document.querySelector<HTMLElement>(`[data-troupe-section="${id}"]`);

    // The pill starts the whole show again.
    const heroRoot = sectionRoot('hero');
    const pillEl = heroRoot ? (pill(heroRoot) as HTMLElement | null) : null;
    const replay = () => {
      played.clear();
      fired.clear();
      finished = false;
      active = null;
      for (const state of states) state.opacity = 0;
    };
    if (pillEl) {
      pillEl.style.cursor = 'pointer';
      pillEl.title = 'Again!';
      pillEl.addEventListener('click', replay);
    }

    const frame = (now: number) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      if (document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = window.scrollX;
      const sy = window.scrollY;

      let next: SectionId | null = null;
      for (const id of [...SECTIONS].reverse()) {
        const root = sectionRoot(id);
        if (root && BEATS[id].active(root.getBoundingClientRect(), vh, root)) {
          next = id;
          break;
        }
      }
      if (next !== active) {
        if (active) played.add(active);
        active = next;
        since = now;
        // Stay with the reader: pull anyone left behind to the viewport's
        // edge, so they come in from there rather than from far away.
        states.forEach((state, i) => {
          if (CAST[i].extra) return;
          state.x = Math.min(sx + vw - 30, Math.max(sx + 30, state.x));
          state.y = Math.min(sy + vh - 40, Math.max(sy + 70, state.y));
        });
      }

      const beat = active ? BEATS[active] : null;
      const root = active ? sectionRoot(active) : null;
      const replaying = Boolean(active && played.has(active));
      const t = beat ? (replaying ? 999 : (now - since) / 1000 - beat.delay) : 0;
      if (active === 'final' && t > FINAL_EXIT) finished = true;

      // Page side effects.
      for (const id of SECTIONS) {
        const b = BEATS[id];
        const r = sectionRoot(id);
        if (b.drive && r) {
          b.drive(r, id === active && !replaying ? 'play' : played.has(id) ? 'done' : 'before', t);
        }
        if (b.htmlFlag) {
          document.documentElement.toggleAttribute(b.htmlFlag, id === active && !finished);
        }
      }
      if (beat?.events && root && !replaying && !finished) {
        beat.events.forEach((event, index) => {
          const key = `${active}:${index}`;
          if (t >= event.at && !fired.has(key)) {
            fired.add(key);
            event.run(root);
          }
        });
      }

      // Masks: a hole the cursors hide behind, or the only window they show in.
      const layer = layerRef.current;
      let maskImage = '';
      if (layer && beat && root && !finished) {
        if (beat.mask && t < beat.mask.until) {
          const hole = beat.mask.anchor(root)?.getBoundingClientRect();
          if (hole) {
            const fill = 'linear-gradient(#000, #000)';
            maskImage = `${fill}, ${fill}`;
            layer.style.maskSize = `100% 100%, ${hole.width}px ${hole.height}px`;
            layer.style.maskPosition = `0 0, ${hole.left}px ${hole.top}px`;
            layer.style.maskComposite = 'exclude';
            layer.style.setProperty('-webkit-mask-composite', 'xor');
          }
        } else if (beat.clip && t >= beat.clip.from) {
          const win = beat.clip.anchor(root)?.getBoundingClientRect();
          if (win) {
            maskImage = `radial-gradient(ellipse ${win.width / 2}px ${win.height / 2}px at ${
              win.left + win.width / 2
            }px ${win.top + win.height / 2}px, #000 96%, transparent 100%)`;
            layer.style.maskSize = '100% 100%';
            layer.style.maskPosition = '0 0';
            layer.style.maskComposite = 'add';
            layer.style.setProperty('-webkit-mask-composite', 'source-over');
          }
        }
        layer.style.maskRepeat = 'no-repeat';
      }
      if (layer && layer.style.maskImage !== maskImage) layer.style.maskImage = maskImage;

      CAST.forEach((member, i) => {
        const state = states[i];
        const el = cursorRefs.current[i];
        const ring = ringRefs.current[i];
        if (!el || !ring) return;
        const part = finished ? undefined : beat?.parts[i];
        let target: { x: number; y: number } | null = null;
        let mark: Mark | null = null;
        let show = false;
        let ox = 0;
        let oy = 0;
        let gestureRot = 0;
        let press = false;
        let pointRot: number | null = null;
        let pulse = -1;
        if (part && root) {
          const current = [...part.marks].reverse().find((m) => m.at <= t) ?? part.marks[0];
          mark = current;
          const anchorEl = current.anchor(root);
          if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            let x = r.left + sx + r.width * (0.5 + (current.fx ?? 0)) + (current.dx ?? 0);
            let y = r.top + sy + r.height * (0.5 + (current.fy ?? 0)) + (current.dy ?? 0);
            if (current.orbit) {
              const angle = current.orbit.phase + current.orbit.speed * (t - current.at);
              x += Math.cos(angle) * current.orbit.r;
              y += Math.sin(angle) * current.orbit.r * (current.orbit.squash ?? 0.5);
            }
            target = { x, y };
            if (current.point) {
              const p = current.point(root)?.getBoundingClientRect();
              if (p) {
                const deg =
                  (Math.atan2(
                    p.top + sy + p.height / 2 - state.y,
                    p.left + sx + p.width / 2 - state.x
                  ) *
                    180) /
                  Math.PI;
                pointRot = ((deg - ARROW_ANGLE + 540) % 360) - 180;
              }
            }
            if (
              part.pressFromAnchor &&
              anchorEl instanceof Element &&
              anchorEl.hasAttribute('data-pressed')
            ) {
              press = true;
            }
          }
          show =
            (Boolean(target) || (part.hold === true && state.opacity > 0.05)) &&
            (part.appear === undefined || t >= part.appear) &&
            (part.vanish === undefined || t < part.vanish);
          for (const cue of part.cues ?? []) {
            const u = (t - cue.at) / GESTURE_SECONDS[cue.gesture];
            if (u >= 0 && u < 1) {
              const g = gestureAt(cue.gesture, u);
              ox += g.ox;
              oy += g.oy;
              gestureRot += g.rot;
              if (g.press) press = true;
              if (cue.gesture === 'click') pulse = u;
            }
          }
          if (current.tremble) {
            ox += Math.sin(now / 37 + i * 1.7) * 1.2;
            oy += Math.cos(now / 29 + i * 2.3) * 0.9;
          }
        } else if (member.extra && state.opacity > 0.05 && !finished) {
          // A guest whose scene is over heads off the side it's nearest.
          const leftward = state.x - sx < vw / 2;
          target = { x: state.x + (leftward ? -1 : 1) * 900, y: state.y };
          const onScreen = state.x > sx - 40 && state.x < sx + vw + 40;
          show = onScreen;
        }
        const busy = part ? isBusy(part, t) : false;
        const wantSize = mark?.size ?? (busy ? 1 : IDLE_SCALE);

        if (target) {
          if (state.opacity < 0.05 && part) {
            state.x = target.x;
            state.y = target.y;
            state.vx = 0;
            state.vy = 0;
          } else {
            // Damped spring, each member a little lazier than the last, plus
            // a sideways pull that bows free moves up and left (a right
            // hand's arc). Locked parts follow stiffly and straight. Small
            // semi-implicit steps: the stiff (9 Hz) follow is unstable at one
            // step per frame.
            const stiff = Boolean(mark?.lock);
            const hz = stiff ? 9 : mark?.orbit ? 5 : member.hz;
            const k = (2 * Math.PI * hz) ** 2;
            const c = 2 * Math.sqrt(k);
            const steps = Math.ceil(dt / (1 / 240));
            const h = dt / steps;
            for (let n = 0; n < steps; n++) {
              const dx = target.x - state.x;
              const dy = target.y - state.y;
              const dist = Math.hypot(dx, dy);
              let ax = k * dx - c * state.vx;
              let ay = k * dy - c * state.vy;
              if (!stiff && !mark?.orbit && dist > 2) {
                let nx = -dy / dist;
                let ny = dx / dist;
                if (nx + ny > 0) {
                  nx = -nx;
                  ny = -ny;
                }
                ax += nx * k * dist * 0.18;
                ay += ny * k * dist * 0.18;
              }
              state.vx += ax * h;
              state.vy += ay * h;
              state.x += state.vx * h;
              state.y += state.vy * h;
            }
          }
        }
        if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
          state.x = target?.x ?? sx + vw / 2;
          state.y = target?.y ?? sy + vh / 2;
          state.vx = 0;
          state.vy = 0;
        }
        state.opacity += ((show ? 1 : 0) - state.opacity) * Math.min(1, dt * 8);
        state.size += (wantSize - state.size) * Math.min(1, dt * 6);
        state.rot += ((pointRot ?? 0) - state.rot) * Math.min(1, dt * 7);
        const fidget = mark?.lock || mark?.orbit ? 0 : Math.sin(now / 760 + i * 2.1) * 2;
        const px = state.x - sx + ox + fidget;
        const py = state.y - sy + oy + fidget * 0.6;
        el.style.opacity = state.opacity.toFixed(3);
        el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${(
          state.rot + gestureRot
        ).toFixed(1)}deg) scale(${(state.size * (press ? 0.8 : 1)).toFixed(3)})`;
        if (pulse >= 0) {
          ring.style.opacity = (1 - pulse).toFixed(3);
          ring.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${(
            0.3 + pulse * 1.4
          ).toFixed(3)})`;
        } else if (ring.style.opacity !== '0') {
          ring.style.opacity = '0';
        }
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      pillEl?.removeEventListener('click', replay);
      for (const id of SECTIONS) {
        const b = BEATS[id];
        const r = sectionRoot(id);
        if (b.drive && r) b.drive(r, 'done', 0);
        if (b.htmlFlag) document.documentElement.removeAttribute(b.htmlFlag);
      }
      if (heroRoot) lightRow(heroRoot, null);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className={styles.layer} ref={layerRef} aria-hidden="true">
      {CAST.map((member, i) => (
        <div
          key={`ring-${member.name}`}
          className={styles.ring}
          style={{ borderColor: member.color }}
          ref={(el) => {
            ringRefs.current[i] = el;
          }}
        />
      ))}
      {CAST.map((member, i) => (
        <div
          key={member.name}
          className={styles.cursor}
          ref={(el) => {
            cursorRefs.current[i] = el;
          }}
        >
          <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
            <path
              d="M2 1l15 8-7 1.6L7 18z"
              fill={member.color}
              stroke="#061010"
              strokeWidth="1.2"
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
