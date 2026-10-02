'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './CursorTroupe.module.css';

/**
 * PROTOTYPE (behind a flag): Three cursors (unnamed; Maya, Ari, and Sam in
 * the code) follow the reader down the home page and act out each section's point. A director picks the section
 * on stage (sections mark themselves with data-troupe-section), plays its
 * beat once, then idles there; cursors spring toward targets anchored to
 * real elements, so they track scrolling and layout. Gestures are motion
 * only. They idle at half size and grow to full size to do things. Shown in dev, or after visiting with `?cursors` once; never under
 * reduced motion or on touch.
 *
 * Beats so far: hero (they pop out of the Multiplayer AI pill and huddle
 * round "alone"), problem (each stuck in its own card, in the problem
 * register), and the hand-off into the Work together demo, whose own Maya,
 * Ari, and Sam take over.
 */

const ENABLED_KEY = 'agor-cursor-troupe';

const CAST = [
  { name: 'Maya', color: '#f5a3c7', hz: 2.1 },
  { name: 'Ari', color: '#6fdcf0', hz: 1.8 },
  { name: 'Sam', color: '#f2d27a', hz: 1.55 },
] as const;

type SectionId = 'hero' | 'problem' | 'work-together';
/** Later sections win ties, so the order doubles as priority (reversed). */
const SECTIONS: SectionId[] = ['hero', 'problem', 'work-together'];

type Anchor = (root: HTMLElement) => Element | null | undefined;
type Gesture = 'wave' | 'shrug' | 'nudge' | 'look';

interface Mark {
  at: number;
  anchor: Anchor;
  /** Offset as a fraction of the anchor's size from its center (-0.5..0.5). */
  fx?: number;
  fy?: number;
  dx?: number;
  dy?: number;
}

interface Part {
  marks: Mark[];
  cues?: Array<{ at: number; gesture: Gesture }>;
  /** Hidden until this time (then pops in at its first mark). */
  appear?: number;
  /** Fades out from this time and stays gone. */
  vanish?: number;
  /** Extra windows (beat seconds) when this cursor is at work, e.g. riding
   * the problem cards through their crash. */
  busy?: Array<[number, number]>;
}

interface Beat {
  delay: number;
  /** Is this section on stage, given its rect, the viewport height, and its root? */
  active: (rect: DOMRect, vh: number, root: HTMLElement) => boolean;
  mood?: 'problem';
  parts: [Part, Part, Part];
}

const pill: Anchor = (root) => root.querySelector('[class*="homeBadge"]');
const alone: Anchor = (root) =>
  [...root.querySelectorAll('h1 span')].find((span) => span.textContent?.trim() === 'alone');
const card =
  (index: number): Anchor =>
  (root) =>
    root.querySelectorAll('article')[index];
const board: Anchor = (root) => root.querySelector('[data-troupe="wt-board"]');

const BEATS: Record<SectionId, Beat> = {
  // Out of the pill, a look around, then a huddle around "alone": you're not.
  hero: {
    delay: 0.4,
    active: (r, vh) => r.bottom > vh * 0.45,
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
  // Siloed: each trapped in its own card, dimmed into the problem register.
  // The beat starts with the section's reveal, so each rides its card through
  // the pile-up crash (their spring lag is the bounce). Then Ari pokes at the
  // edge of its card and gets nowhere, and they shrug.
  problem: {
    delay: 0,
    active: (r, vh, root) => root.className.includes('isVisible') && r.bottom > vh * 0.45,
    mood: 'problem',
    parts: [
      {
        marks: [{ at: 0, anchor: card(0), fx: 0.3, fy: 0.4 }],
        busy: [[0, 1.4]],
        cues: [{ at: 3.9, gesture: 'shrug' }],
      },
      {
        marks: [
          { at: 0, anchor: card(2), fx: 0.3, fy: 0.4 },
          { at: 2.0, anchor: card(2), fx: 0.44, fy: 0.1 },
          { at: 3.3, anchor: card(2), fx: 0.3, fy: 0.4 },
        ],
        busy: [[0, 1.4]],
        cues: [{ at: 2.4, gesture: 'nudge' }],
      },
      {
        marks: [{ at: 0, anchor: card(4), fx: 0.3, fy: 0.4 }],
        busy: [[0, 1.4]],
        cues: [
          { at: 2.5, gesture: 'look' },
          { at: 4.0, gesture: 'shrug' },
        ],
      },
    ],
  },
  // Hand-off: each heads for the edge its demo counterpart enters from (left,
  // bottom, right) and fades as the demo's own cursors arrive.
  'work-together': {
    delay: 0,
    active: (r, vh) => r.top < vh * 0.75 && r.bottom > vh * 0.2,
    parts: [
      { marks: [{ at: 0, anchor: board, fx: -0.5, fy: -0.25, dx: 10 }], vanish: 0.9 },
      { marks: [{ at: 0, anchor: board, fy: 0.5, dy: -10 }], vanish: 1.0 },
      { marks: [{ at: 0, anchor: board, fx: 0.5, fy: -0.25, dx: -10 }], vanish: 1.1 },
    ],
  },
};

/** Size while idling and travelling; they grow to full size to do things. */
const IDLE_SCALE = 0.5;
/** A purposeful move to a new mark counts as doing something for this long. */
const MOVE_SECONDS = 1.1;

/** Is this cursor doing something at beat time `t` (a gesture, a deliberate
 * move to a later mark, or a part's own busy window)? Padded so the grow
 * starts just before and the shrink waits just after. */
function isBusy(part: Part, t: number): boolean {
  const pad = 0.25;
  const within = (a: number, b: number) => t >= a - pad && t < b + pad;
  return (
    (part.cues ?? []).some((cue) => within(cue.at, cue.at + GESTURE_SECONDS[cue.gesture])) ||
    part.marks.slice(1).some((mark) => within(mark.at, mark.at + MOVE_SECONDS)) ||
    (part.busy ?? []).some(([a, b]) => within(a, b))
  );
}

const GESTURE_SECONDS: Record<Gesture, number> = { wave: 0.9, shrug: 0.7, nudge: 0.9, look: 1.0 };

/** Offset (px) and tilt (deg) for a gesture `u` (0..1) of the way through. */
function gestureAt(gesture: Gesture, u: number): { ox: number; oy: number; rot: number } {
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
  }
}

interface CursorState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  opacity: number;
  scale: number;
  /** Eases between IDLE_SCALE and 1. */
  size: number;
}

export function CursorTroupe() {
  const [enabled, setEnabled] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const cursorRefs = useRef<Array<HTMLDivElement | null>>([]);

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
      opacity: 0,
      scale: 1,
      size: IDLE_SCALE,
    }));
    const played = new Set<SectionId>();
    let active: SectionId | null = null;
    let since = performance.now();
    let last = since;
    let raf = 0;

    const sectionRoot = (id: SectionId) =>
      document.querySelector<HTMLElement>(`[data-troupe-section="${id}"]`);

    const frame = (now: number) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      if (document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const vh = window.innerHeight;

      // Who's on stage: the last section (in page order) whose rule matches.
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
      }

      const beat = active ? BEATS[active] : null;
      const root = active ? sectionRoot(active) : null;
      // A beat plays once per visit; coming back, they idle where it ended.
      const t = beat ? (active && played.has(active) ? 999 : (now - since) / 1000 - beat.delay) : 0;
      layerRef.current?.toggleAttribute('data-problem', beat?.mood === 'problem');

      CAST.forEach((member, i) => {
        const state = states[i];
        const el = cursorRefs.current[i];
        if (!el) return;
        const part = beat?.parts[i];
        let target: { x: number; y: number } | null = null;
        let show = false;
        let ox = 0;
        let oy = 0;
        let rot = 0;
        let busy = false;
        if (part && root) {
          busy = isBusy(part, t);
          const mark = [...part.marks].reverse().find((m) => m.at <= t) ?? part.marks[0];
          const anchorEl = mark.anchor(root);
          if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            target = {
              x: r.left + r.width * (0.5 + (mark.fx ?? 0)) + (mark.dx ?? 0),
              y: r.top + r.height * (0.5 + (mark.fy ?? 0)) + (mark.dy ?? 0),
            };
          }
          show =
            Boolean(target) &&
            (part.appear === undefined || t >= part.appear) &&
            (part.vanish === undefined || t < part.vanish);
          for (const cue of part.cues ?? []) {
            const u = (t - cue.at) / GESTURE_SECONDS[cue.gesture];
            if (u >= 0 && u < 1) {
              const g = gestureAt(cue.gesture, u);
              ox += g.ox;
              oy += g.oy;
              rot += g.rot;
            }
          }
        }

        if (target) {
          if (state.opacity < 0.05) {
            // Arriving from nowhere: start at the target rather than flying
            // in from wherever the last section left them.
            state.x = target.x;
            state.y = target.y;
            state.vx = 0;
            state.vy = 0;
            if (show) state.scale = 0;
          } else {
            // Critically damped spring, each member a little lazier than the
            // last, plus a sideways pull that bows the path up and left the
            // way a right-handed mouse arcs.
            const k = (2 * Math.PI * member.hz) ** 2;
            const c = 2 * Math.sqrt(k);
            const dx = target.x - state.x;
            const dy = target.y - state.y;
            const dist = Math.hypot(dx, dy);
            let ax = k * dx - c * state.vx;
            let ay = k * dy - c * state.vy;
            if (dist > 2) {
              let nx = -dy / dist;
              let ny = dx / dist;
              if (nx + ny > 0) {
                nx = -nx;
                ny = -ny;
              }
              ax += nx * k * dist * 0.18;
              ay += ny * k * dist * 0.18;
            }
            state.vx += ax * dt;
            state.vy += ay * dt;
            state.x += state.vx * dt;
            state.y += state.vy * dt;
          }
        }
        state.opacity += ((show ? 1 : 0) - state.opacity) * Math.min(1, dt * 8);
        state.scale += (1 - state.scale) * Math.min(1, dt * 9);
        state.size += ((busy ? 1 : IDLE_SCALE) - state.size) * Math.min(1, dt * 6);
        const fidget = Math.sin(now / 760 + i * 2.1) * 2;
        el.style.opacity = state.opacity.toFixed(3);
        el.style.transform = `translate(${(state.x + ox + fidget).toFixed(1)}px, ${(
          state.y + oy + fidget * 0.6
        ).toFixed(
          1
        )}px) rotate(${rot.toFixed(1)}deg) scale(${(state.scale * state.size).toFixed(3)})`;
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className={styles.layer} ref={layerRef} aria-hidden="true">
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
