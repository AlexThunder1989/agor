'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './CursorTroupe.module.css';

/**
 * PROTOTYPE (behind a flag): three cursors (Maya, Ari, and Sam in the code;
 * unnamed on screen) follow the reader down the home page and act out each
 * section's point. A director picks the section on stage (sections mark
 * themselves with data-troupe-section) and plays its beat once.
 *
 * Positions live in page coordinates and every target is re-read from a real
 * element each frame, so cursors stay locked to what they're touching while
 * the page scrolls. They idle at half size, grow to full size to do things,
 * and gestures are motion only. Beats can also nudge the page itself: hover
 * a ring node or radar blip (synthetic mouseover), or drive an element (the
 * board panel they haul on screen). Clicking the hero's "Multiplayer AI" pill
 * sends them back in. Shown in dev, or after visiting with `?cursors` once;
 * never under reduced motion or on touch.
 */

const ENABLED_KEY = 'agor-cursor-troupe';

const CAST = [
  { name: 'Maya', color: '#f5a3c7', hz: 2.1 },
  { name: 'Ari', color: '#6fdcf0', hz: 1.8 },
  { name: 'Sam', color: '#f2d27a', hz: 1.55 },
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

type Anchor = (root: HTMLElement) => Element | null | undefined;
type Gesture = 'wave' | 'shrug' | 'nudge' | 'look' | 'jump' | 'heave' | 'click';

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
  /** Turn to point at this element's center. */
  point?: Anchor;
  /** Circle the target point (an ellipse, radius r, radians per second). */
  orbit?: { r: number; speed: number; phase: number };
  /** Bounce around inside the anchor's box, like something trapped in it. */
  roam?: { inset: number; speed: number; angle: number };
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
  /** Trapped: behind the section's glass, in the problem register. */
  behind?: boolean;
  /** Hide the cursors behind this element (a hole in the layer) until `until`. */
  mask?: { anchor: Anchor; until: number };
  parts: [Part, Part, Part];
  /** One-shot side effects on the page, e.g. hovering a node. */
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

const hover = (el?: Element | null) =>
  el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
const unhover = (el?: Element | null) =>
  el?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));

const centerBand = (r: DOMRect, vh: number) => r.top < vh * 0.6 && r.bottom > vh * 0.4;

const pill = q('[class*="homeBadge"]');
const alone: Anchor = (root) =>
  [...root.querySelectorAll('h1 span')].find((span) => span.textContent?.trim() === 'alone');
const problemCard = (i: number) => nth('article', i);
const demoCursor = (i: number) => q(`[data-troupe-cursor="${i}"]`);
const boardPanel = q('[data-troupe="board-panel"]');
const RING_NODE = 'a[class*="ringNode"]';
const ringNode = (i: number) => nth(RING_NODE, i);
const ringHub = q('[class*="ringHub"]');
const LINKED_BLIP = 'a[class*="radarBlip"]';
const blip = (i: number) => nth(LINKED_BLIP, i);
const rosterLink = q('a[href="/agent-roster"]');
const ccHeading = q('h2');
const govLink: Anchor = (root) =>
  [...root.querySelectorAll('a')].find((a) => a.textContent?.includes('Explore Governance'));
const together = q('[data-troupe="together"]');
const ctaButton = (i: number) => nth('[class*="heroActions"] > *', i);

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

const BEATS: Record<SectionId, Beat> = {
  // Out from behind the Multiplayer AI pill, a look around, then a huddle
  // around "alone": you're not.
  hero: {
    delay: 0.4,
    active: (r, vh) => r.bottom > vh * 0.45,
    mask: { anchor: pill, until: 1.6 },
    parts: [
      {
        appear: 0,
        marks: [
          { at: 0, anchor: pill },
          { at: 0.15, anchor: pill, fx: -0.5, dx: -40, dy: 30 },
          { at: 1.9, anchor: alone, fx: -0.5, dx: -36, dy: -14 },
        ],
        cues: [{ at: 1.0, gesture: 'look' }],
      },
      {
        appear: 0.25,
        marks: [
          { at: 0, anchor: pill },
          { at: 0.4, anchor: pill, fx: 0.5, dx: 30, dy: 26 },
          { at: 2.1, anchor: alone, fx: 0.5, dx: 14, dy: -30 },
        ],
        cues: [
          { at: 1.2, gesture: 'look' },
          { at: 3.3, gesture: 'wave' },
        ],
      },
      {
        appear: 0.5,
        marks: [
          { at: 0, anchor: pill },
          { at: 0.65, anchor: pill, dy: 58 },
          { at: 2.3, anchor: alone, fy: 0.5, dx: -6, dy: -2 },
        ],
        cues: [{ at: 1.35, gesture: 'look' }],
      },
    ],
  },
  // Siloed: each trapped behind the glass of its own card, bouncing off its
  // walls. Starts with the section's reveal, so they ride the pile-up crash.
  problem: {
    delay: 0,
    active: (r, vh, root) =>
      root.className.includes('isVisible') && r.top < vh * 0.85 && r.bottom > vh * 0.4,
    behind: true,
    parts: [0, 2, 4].map((card, i) => ({
      marks: [
        { at: 0, anchor: problemCard(card), lock: true },
        {
          at: 0.2,
          anchor: problemCard(card),
          lock: true,
          roam: { inset: 18, speed: 70 + i * 18, angle: 0.7 + i * 2.1 },
        },
      ],
      cues: [{ at: 3.6 + i * 0.3, gesture: 'shrug' as const }],
      // Full size the whole time: they're stuck, not idling.
      busy: [[0, 60]],
    })) as [Part, Part, Part],
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
    })) as [Part, Part, Part],
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
        { at: 4.8, anchor: boardPanel, fx: -0.5, fy: 0.5, dx: -22 - i * 26, dy: 24 },
      ],
      cues: BOARD_PULLS.map(([a]) => ({ at: a - 0.3, gesture: 'heave' as const })),
      busy: [[1.0, 4.7]],
    })) as [Part, Part, Part],
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
    })) as [Part, Part, Part],
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
    })) as [Part, Part, Part],
    events: [
      { at: 0.7, run: (root) => hover(blip(0)(root)) },
      {
        at: 1.3,
        run: (root) => {
          unhover(blip(0)(root));
          hover(blip(1)(root));
        },
      },
      {
        at: 1.9,
        run: (root) => {
          unhover(blip(1)(root));
          hover(blip(2)(root));
        },
      },
      {
        at: 2.7,
        run: (root) => {
          unhover(blip(2)(root));
          hover(blip(3)(root));
        },
      },
      {
        at: 3.3,
        run: (root) => {
          unhover(blip(3)(root));
          hover(blip(4)(root));
        },
      },
      { at: 3.9, run: (root) => unhover(blip(4)(root)) },
    ],
  },
  // "Explore Governance" is the point here: they gather and point at it.
  governance: {
    delay: 0.3,
    active: centerBand,
    parts: [0, 1, 2].map((i) => ({
      marks: [
        { at: 0, anchor: govLink, fx: 0.5, dx: 36 + i * 30, dy: -20 + i * 22, point: govLink },
      ],
      busy: [[0.6, 2.0]],
    })) as [Part, Part, Part],
  },
  // Ease in to "together", a little orbit dance around it, then each clicks a
  // CTA and they're off.
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
    })) as [Part, Part, Part],
  },
};

const GESTURE_SECONDS: Record<Gesture, number> = {
  wave: 0.9,
  shrug: 0.7,
  nudge: 0.9,
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
    case 'nudge':
      return { ox: Math.abs(Math.sin(u * Math.PI * 3)) * 10, oy: 0, rot: 0 };
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

const IDLE_SCALE = 0.5;
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
  /** Position inside a roam box, relative to its inset top-left. */
  roam: { x: number; y: number; vx: number; vy: number; box: Element | null };
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
      roam: { x: 0, y: 0, vx: 0, vy: 0, box: null },
    }));
    const played = new Set<SectionId>();
    const fired = new Set<string>();
    let active: SectionId | null = null;
    let since = performance.now();
    let last = since;
    let raf = 0;

    const sectionRoot = (id: SectionId) =>
      document.querySelector<HTMLElement>(`[data-troupe-section="${id}"]`);

    // The pill sends them back in.
    const heroRoot = sectionRoot('hero');
    const pillEl = heroRoot ? (pill(heroRoot) as HTMLElement | null) : null;
    const replay = () => {
      played.delete('hero');
      for (const key of [...fired]) if (key.startsWith('hero:')) fired.delete(key);
      if (active === 'hero') since = performance.now();
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
        for (const state of states) {
          state.x = Math.min(sx + vw - 30, Math.max(sx + 30, state.x));
          state.y = Math.min(sy + vh - 40, Math.max(sy + 70, state.y));
          state.roam.box = null;
        }
      }

      const beat = active ? BEATS[active] : null;
      const root = active ? sectionRoot(active) : null;
      const replaying = Boolean(active && played.has(active));
      const t = beat ? (replaying ? 999 : (now - since) / 1000 - beat.delay) : 0;

      // Page side effects.
      for (const id of SECTIONS) {
        const b = BEATS[id];
        const r = sectionRoot(id);
        if (b.drive && r) {
          b.drive(r, id === active && !replaying ? 'play' : played.has(id) ? 'done' : 'before', t);
        }
        if (b.htmlFlag) document.documentElement.toggleAttribute(b.htmlFlag, id === active);
      }
      if (beat?.events && root && !replaying) {
        beat.events.forEach((event, index) => {
          const key = `${active}:${index}`;
          if (t >= event.at && !fired.has(key)) {
            fired.add(key);
            event.run(root);
          }
        });
      }

      const layer = layerRef.current;
      layer?.toggleAttribute('data-behind', Boolean(beat?.behind));
      let masking = false;
      if (layer && beat?.mask && root && t < beat.mask.until) {
        const hole = beat.mask.anchor(root)?.getBoundingClientRect();
        if (hole) {
          masking = true;
          const fill = 'linear-gradient(#000, #000)';
          layer.style.maskImage = `${fill}, ${fill}`;
          layer.style.maskSize = `100% 100%, ${hole.width}px ${hole.height}px`;
          layer.style.maskPosition = `0 0, ${hole.left}px ${hole.top}px`;
          layer.style.maskRepeat = 'no-repeat';
          layer.style.maskComposite = 'exclude';
          layer.style.setProperty('-webkit-mask-composite', 'xor');
        }
      }
      if (layer && !masking && layer.style.maskImage) {
        layer.style.maskImage = '';
      }

      CAST.forEach((member, i) => {
        const state = states[i];
        const el = cursorRefs.current[i];
        const ring = ringRefs.current[i];
        if (!el || !ring) return;
        const part = beat?.parts[i];
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
              y += Math.sin(angle) * current.orbit.r * 0.5;
            }
            if (current.roam) {
              const { inset, speed, angle } = current.roam;
              const w = Math.max(10, r.width - 2 * inset);
              const h = Math.max(10, r.height - 2 * inset);
              const ro = state.roam;
              if (ro.box !== anchorEl) {
                ro.box = anchorEl;
                ro.x = Math.min(w, Math.max(0, state.x - (r.left + sx + inset)));
                ro.y = Math.min(h, Math.max(0, state.y - (r.top + sy + inset)));
                ro.vx = Math.cos(angle) * speed;
                ro.vy = Math.sin(angle) * speed;
              }
              ro.x += ro.vx * dt;
              ro.y += ro.vy * dt;
              if (ro.x < 0 || ro.x > w) {
                ro.vx = -ro.vx;
                ro.x = Math.min(w, Math.max(0, ro.x));
              }
              if (ro.y < 0 || ro.y > h) {
                ro.vy = -ro.vy;
                ro.y = Math.min(h, Math.max(0, ro.y));
              }
              x = r.left + sx + inset + ro.x;
              y = r.top + sy + inset + ro.y;
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
            if (part.pressFromAnchor && anchorEl.hasAttribute('data-pressed')) press = true;
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
        }
        const busy = part ? isBusy(part, t) : false;

        if (target) {
          if (state.opacity < 0.05) {
            state.x = target.x;
            state.y = target.y;
            state.vx = 0;
            state.vy = 0;
          } else {
            // Damped spring, each member a little lazier than the last, plus
            // a sideways pull that bows free moves up and left (a right
            // hand's arc). Locked parts follow stiffly and straight.
            const stiff = Boolean(mark?.lock || mark?.roam);
            const hz = stiff ? 9 : mark?.orbit ? 5 : member.hz;
            const k = (2 * Math.PI * hz) ** 2;
            const c = 2 * Math.sqrt(k);
            // Small semi-implicit steps: the stiff (9 Hz) follow is unstable
            // at one step per frame.
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
        state.size += ((busy ? 1 : IDLE_SCALE) - state.size) * Math.min(1, dt * 6);
        state.rot += ((pointRot ?? 0) - state.rot) * Math.min(1, dt * 7);
        const fidget = mark?.lock || mark?.roam ? 0 : Math.sin(now / 760 + i * 2.1) * 2;
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
