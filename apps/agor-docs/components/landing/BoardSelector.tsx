'use client';

import { Pause, Play } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import Aurora from '../Aurora/Aurora';
import landing from '../LandingPage.module.css';
import styles from './BoardSelector.module.css';
import { LearnMore } from './LandingLink';

/**
 * Home-page board section (design handoff "feature demo selector", 1c): four
 * features on the left drive an animated demo panel on the right. Each panel
 * is a short scripted loop ("clip") of STEPS ticks; its tab's progress bar
 * fills over exactly that loop and the next tab takes over when it ends.
 * Clicking a tab holds it (auto-advance stops, its clip keeps looping).
 *
 * The panels are illustrations drawn in HTML, not captures, so keep what
 * they show inside what /board's detail blocks (details/board.ts) claim.
 */

const TICK_MS = 800;

interface Feature {
  id: string;
  anchor: string;
  label: string;
  body: string;
  /** Ticks in this feature's clip. */
  steps: number;
  Panel: (props: { step: number }) => ReactNode;
}

// Design-space stage every panel is drawn in; scaled to fit its frame.
const STAGE_W = 700;
const STAGE_H = 500;

function Cursor({ name, color, x, y }: { name: string; color: string; x: number; y: number }) {
  return (
    <div className={styles.cursor} style={{ transform: `translate(${x}px, ${y}px)` }}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M2 1l15 8-7 1.6L7 18z" fill={color} stroke="#061010" strokeWidth="1.2" />
      </svg>
      <span className={styles.cursorName} style={{ background: color }}>
        {name}
      </span>
    </div>
  );
}

const on = (condition: boolean, className: string) => (condition ? ` ${className}` : '');

/* Boards & zones: a branch is dragged into a zone and the zone's prompt
 * template starts a session on it. */
function ZonesPanel({ step }: { step: number }) {
  const dropped = step >= 3;
  const cursor = [
    { x: 250, y: 440 },
    { x: 180, y: 300 },
    { x: 540, y: 150 },
    { x: 540, y: 150 },
    { x: 610, y: 420 },
  ][Math.min(step, 4)];
  return (
    <>
      <div className={`${styles.zone} ${styles.zoneLeft}`}>
        <span className={styles.zoneTitle}>Ship this week</span>
      </div>
      <div className={`${styles.zone} ${styles.zoneRight}${on(step === 3, styles.zoneHot)}`}>
        <span className={styles.zoneTitle}>Review lane</span>
        <span className={styles.zonePrompt}>Prompt template</span>
      </div>
      <div className={styles.card} style={{ left: 44, top: 104 }}>
        <div className={styles.cardTitle}>landing-hero-polish</div>
        <div className={styles.cardMeta}>Issue #214 · PR #1248</div>
      </div>
      <div
        className={`${styles.card} ${styles.cardMoving}${on(step === 2, styles.cardLifted)}`}
        style={{ left: dropped || step === 2 ? 396 : 44, top: dropped || step === 2 ? 118 : 262 }}
      >
        <div className={styles.cardTitle}>rbac-safe-defaults</div>
        <div className={styles.cardMeta}>Issue #42 · PR #1254</div>
        <div className={`${styles.collapse}${on(step >= 4, styles.shown)}`}>
          <div className={styles.firedPrompt}>
            Review this branch: #42, PR #1254. Check the RBAC defaults and add tests.
          </div>
        </div>
        <div className={`${styles.collapse}${on(step >= 5, styles.shown)}`}>
          <div className={styles.sessionRow}>
            <span className={`${styles.dot} ${styles.dotRunning}`} />
            Claude · review started
          </div>
        </div>
      </div>
      <Cursor name="Ari" color="#6fdcf0" x={cursor.x} y={cursor.y} />
    </>
  );
}

/* What needs you: one card glows because its session wants input; answer it
 * and the glow settles. The browser tab mirrors the status. */
function AttentionPanel({ step }: { step: number }) {
  const waiting = step >= 2 && step < 8;
  const answered = step >= 8;
  const cursor =
    step >= 5 ? { x: 600, y: 200 } : step >= 4 ? { x: 520, y: 330 } : { x: 600, y: 470 };
  return (
    <>
      <div className={styles.browserTab}>
        <span className={`${styles.favicon}${on(waiting, styles.faviconWaiting)}`} />
        {waiting ? 'Agor · 1 needs you' : 'Agor · 3 running'}
      </div>
      <div className={styles.card} style={{ left: 40, top: 96, width: 290 }}>
        <div className={styles.cardTitle}>checkout-v2</div>
        <div className={styles.cardMeta}>
          <span className={`${styles.dot} ${styles.dotRunning}`} /> Claude · running
        </div>
        <div className={styles.cost}>$0.21 · last prompt</div>
      </div>
      <div className={styles.card} style={{ left: 40, top: 262, width: 290 }}>
        <div className={styles.cardTitle}>release-notes</div>
        <div className={styles.cardMeta}>
          <span className={`${styles.dot} ${styles.dotDone}`} /> Gemini · finished
        </div>
        <div className={styles.cost}>$0.09 · last prompt</div>
      </div>
      <div
        className={`${styles.card}${on(waiting, styles.cardGlow)}`}
        style={{ left: 370, top: 96, width: 290 }}
      >
        <div className={styles.cardTitle}>flaky-tests</div>
        <div className={styles.cardMeta}>
          <span className={`${styles.dot} ${waiting ? styles.dotWaiting : styles.dotRunning}`} />
          Codex · {waiting ? 'needs input' : 'running'}
        </div>
        <div className={`${styles.collapse}${on(step >= 5 && step < 8, styles.shown)}`}>
          <div className={styles.question}>
            Quarantine the 3 flaky specs and open an issue?
            <span className={`${styles.answer}${on(step >= 7, styles.answerPressed)}`}>Yes</span>
          </div>
        </div>
        <div className={`${styles.cost}${on(answered, styles.costFresh)}`}>
          {answered ? '$0.38 · this prompt' : '$0.12 · last prompt'}
        </div>
      </div>
      <Cursor name="Maya" color="#f5a3c7" x={cursor.x} y={cursor.y} />
    </>
  );
}

/* Agent sessions: tool calls arrive as blocks, a follow-up is queued while
 * the agent works, and a child session is spawned into the tree. */
function SessionPanel({ step }: { step: number }) {
  const blocks = [
    { tool: 'Read', detail: 'components/Hero.tsx' },
    { tool: 'Edit', detail: 'Hero.tsx  +12 −5' },
    { tool: 'Bash', detail: 'pnpm test  ✓ 42 passed' },
  ];
  return (
    <div className={styles.session}>
      <div className={styles.sessionHead}>
        <span>
          <span className={`${styles.dot} ${styles.dotRunning}`} />
          Claude · landing-hero-polish
        </span>
        <span className={styles.sessionMeta}>working</span>
      </div>
      <div className={styles.userMsg}>
        <span className={styles.avatar} style={{ background: '#6fdcf0' }}>
          AR
        </span>
        Tighten the hero copy and bump the CTA contrast.
      </div>
      {blocks.map((block, index) => (
        <div
          key={block.tool}
          className={`${styles.toolBlock}${on(step >= index + 1, styles.shown)}`}
        >
          <span className={styles.toolName}>{block.tool}</span>
          {block.detail}
        </div>
      ))}
      <div className={`${styles.agentMsg}${on(step >= 5, styles.shown)}`}>
        Done: headline tightened, CTA contrast now passes AA.
      </div>
      <div className={`${styles.tree}${on(step >= 7, styles.shown)}`}>
        ↳ spawned <strong>visual-critique</strong> · Gemini
      </div>
      <div className={styles.composer}>
        <span className={`${styles.queued}${on(step >= 3 && step < 6, styles.shown)}`}>
          Queued · Mina: also check the mobile crop
        </span>
        <span className={`${styles.queued}${on(step >= 6, styles.shown)}`}>
          Running Mina’s follow-up
        </span>
      </div>
    </div>
  );
}

/* Slack & more: someone mentions the bot in a thread; it starts a session as
 * them and replies in place. */
function GatewayPanel({ step }: { step: number }) {
  return (
    <div className={styles.thread}>
      <div className={styles.threadHead}># launch · thread</div>
      <div className={styles.chatMsg}>
        <span className={styles.avatar} style={{ background: '#f5a3c7' }}>
          MA
        </span>
        <div>
          <div className={styles.chatName}>Maya</div>
          <span className={styles.mention}>@agor</span> draft the release notes for PR #1248?
        </div>
      </div>
      <div className={`${styles.collapse}${on(step === 1, styles.shown)}`}>
        <div className={styles.typing}>agor is typing…</div>
      </div>
      <div className={`${styles.chatMsg} ${styles.reveal}${on(step >= 2, styles.shown)}`}>
        <span className={`${styles.avatar} ${styles.avatarBot}`}>A</span>
        <div>
          <div className={styles.chatName}>
            agor <span className={styles.chatAs}>running as Maya</span>
          </div>
          On it. Started a session on <strong>release-notes</strong>.
          <span className={styles.sessionLink}>Open session on the board</span>
        </div>
      </div>
      <div className={`${styles.chatMsg} ${styles.reveal}${on(step >= 5, styles.shown)}`}>
        <span className={`${styles.avatar} ${styles.avatarBot}`}>A</span>
        <div>
          Draft ready: 5 changes, 2 docs links. Want it on the PR?
          <span className={`${styles.reaction}${on(step >= 7, styles.shown)}`}>✓ 2</span>
        </div>
      </div>
      <div className={`${styles.chatMsg} ${styles.reveal}${on(step >= 6, styles.shown)}`}>
        <span className={styles.avatar} style={{ background: '#f5a3c7' }}>
          MA
        </span>
        <div>Yes, add it.</div>
      </div>
    </div>
  );
}

const FEATURES: Feature[] = [
  {
    id: 'zones',
    anchor: 'boards-and-zones',
    label: 'Boards & zones',
    body: 'Give every piece of work a place. Drop a branch into a zone and its prompt template starts the next step.',
    steps: 10,
    Panel: ZonesPanel,
  },
  {
    id: 'attention',
    anchor: 'attention',
    label: 'What needs you',
    body: 'Cards glow when an agent is waiting on you, the browser tab shows it too, and every prompt shows what it cost.',
    steps: 10,
    Panel: AttentionPanel,
  },
  {
    id: 'sessions',
    anchor: 'sessions',
    label: 'Agent sessions',
    body: 'Follow tool calls as they happen, queue the next instruction while the agent works, and branch off child sessions.',
    steps: 10,
    Panel: SessionPanel,
  },
  {
    id: 'gateway',
    anchor: 'gateway',
    label: 'Slack & more',
    body: 'Mention your Agor bot in Slack, Discord, GitHub, or Shortcut. It runs as the person who asked and replies in the thread.',
    steps: 10,
    Panel: GatewayPanel,
  },
];

interface State {
  active: number;
  step: number;
  held: boolean;
  /** Bumped on every click, so the clock restarts in phase with the new clip. */
  epoch: number;
}

type Action = { type: 'tick' } | { type: 'select'; index: number };

function reducer(state: State, action: Action): State {
  if (action.type === 'select') {
    return { active: action.index, step: 0, held: true, epoch: state.epoch + 1 };
  }
  const next = state.step + 1;
  if (next < FEATURES[state.active].steps) return { ...state, step: next };
  if (state.held) return { ...state, step: 0 };
  return { ...state, active: (state.active + 1) % FEATURES.length, step: 0 };
}

/** The scaled demo stage. Rendered twice (desktop column, phone accordion);
 * CSS hides one, and a hidden stage measures 0 wide and does no work. */
function DemoPanel({
  feature,
  step,
  paused,
  onTogglePause,
  className,
}: {
  feature: Feature;
  step: number;
  paused: boolean;
  onTogglePause: () => void;
  className: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width) setScale(entry.contentRect.width / STAGE_W);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`${styles.panel} ${className}`} ref={frameRef}>
      <div
        key={feature.id}
        className={styles.stage}
        style={{ width: STAGE_W, height: STAGE_H, '--stage-scale': scale } as CSSProperties}
        aria-hidden="true"
      >
        <feature.Panel step={step} />
      </div>
      <button
        type="button"
        className={styles.pauseToggle}
        onClick={onTogglePause}
        aria-label={paused ? 'Play the demo' : 'Pause the demo'}
      >
        {paused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
      </button>
    </div>
  );
}

export function BoardSelector() {
  const [state, dispatch] = useReducer(reducer, { active: 0, step: 0, held: false, epoch: 0 });
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Only run the clock while the section is on screen.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.2,
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const running = visible && !reduced && !userPaused;
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the clock on a click, so the held clip's ticks line up with its progress bar
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => dispatch({ type: 'tick' }), TICK_MS);
    return () => clearInterval(timer);
  }, [running, state.epoch]);

  const active = FEATURES[state.active];
  // Reduced motion shows each clip's end state; a user pause freezes in place.
  const step = reduced ? active.steps - 1 : state.step;
  const progress = (index: number) => {
    if (index !== state.active) return 0;
    if (state.held || reduced) return 1;
    return (state.step + 1) / active.steps;
  };

  const panelProps = {
    feature: active,
    step,
    paused: userPaused || reduced,
    onTogglePause: () => setUserPaused((value) => !value),
  };

  return (
    <section
      className={`${landing.showcaseSection} ${styles.section}`}
      ref={sectionRef}
      data-reveal
    >
      <div className={landing.showcaseDivider} aria-hidden="true">
        <Aurora
          colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
          amplitude={0.9}
          blend={1}
          speed={0.6}
        />
      </div>
      <div className={`${landing.sectionHeader} ${styles.head}`}>
        <h2>
          See the work and <span className={landing.headingStrong}>shape</span> it{' '}
          <span className={landing.headingAccent}>together</span>
        </h2>
        <p className={styles.sub}>
          <span className={styles.subLead}>A live board for all your agent work.</span> Organize it,
          see what needs you, and follow every session, from the canvas or the threads your team
          already uses.
        </p>
      </div>
      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.tabs} role="tablist" aria-label="Board features">
            {FEATURES.map((feature, index) => {
              const isActive = index === state.active;
              return (
                <div key={feature.id} className={styles.tabItem}>
                  <button
                    type="button"
                    role="tab"
                    id={`board-tab-${feature.id}`}
                    aria-selected={isActive}
                    className={`${styles.tab}${on(isActive, styles.tabActive)}`}
                    onClick={() => dispatch({ type: 'select', index })}
                  >
                    <span className={styles.tabTitle}>{feature.label}</span>
                    <span className={styles.tabBody}>{feature.body}</span>
                    <span className={styles.track} aria-hidden="true">
                      <span
                        className={`${styles.fill}${on(isActive && !state.held && !reduced, styles.fillTiming)}`}
                        style={{ transform: `scaleX(${progress(index)})` }}
                      />
                    </span>
                  </button>
                  {isActive && <DemoPanel {...panelProps} className={styles.panelInline} />}
                </div>
              );
            })}
          </div>
          <LearnMore
            page="board"
            placement="home-section"
            anchor={active.anchor}
            label={`More on ${active.label.toLowerCase()}`}
          />
        </div>
        <DemoPanel {...panelProps} className={styles.panelSide} />
      </div>
    </section>
  );
}
