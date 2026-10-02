'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import Aurora from '../Aurora/Aurora';
import landing from '../LandingPage.module.css';
import styles from './BoardSelector.module.css';
import { boardDetails } from './details/board';
import type { DetailMedia } from './details/types';
import { LandingLink } from './LandingLink';

/**
 * Home-page board section (design handoff "feature demo selector", 1c): four
 * features on the left drive the media panel on the right. The media are the
 * real captures /board's detail blocks use (looked up by anchor, so the two
 * never drift apart). Each tab's progress bar follows its clip's playback and
 * the next tab takes over when the clip ends; a still gets STILL_MS. Clicking
 * a tab holds it (auto-advance stops, the clip loops).
 */

const STILL_MS = 8000;

interface Feature {
  anchor: string;
  label: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    anchor: 'boards-and-zones',
    label: 'Boards & zones',
    body: 'Give every piece of work a place. Drop a branch into a zone and its prompt template starts the next step.',
  },
  {
    anchor: 'attention',
    label: 'What needs you',
    body: 'Cards glow when an agent is waiting on you, the browser tab shows it too, and every prompt shows what it cost.',
  },
  {
    anchor: 'sessions',
    label: 'Agent sessions',
    body: 'Follow tool calls as they happen, queue the next instruction while the agent works, and branch off child sessions.',
  },
  {
    anchor: 'gateway',
    label: 'Slack & more',
    body: 'Mention your Agor bot in Slack, Discord, GitHub, or Shortcut. It runs as the person who asked and replies in the thread.',
  },
];

function mediaFor(anchor: string): DetailMedia | undefined {
  return boardDetails.find((detail) => detail.id === anchor)?.media;
}

interface State {
  active: number;
  held: boolean;
}

type Action = { type: 'next' } | { type: 'select'; index: number };

function reducer(state: State, action: Action): State {
  if (action.type === 'select') return { active: action.index, held: true };
  if (state.held) return state;
  return { ...state, active: (state.active + 1) % FEATURES.length };
}

const on = (condition: boolean, className: string) => (condition ? ` ${className}` : '');

export function BoardSelector() {
  const [state, dispatch] = useReducer(reducer, { active: 0, held: false });
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [progress, setProgress] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const narrow = window.matchMedia('(max-width: 1100px)');
    const sync = () => {
      setReduced(motion.matches);
      setStacked(narrow.matches);
    };
    sync();
    motion.addEventListener('change', sync);
    narrow.addEventListener('change', sync);
    return () => {
      motion.removeEventListener('change', sync);
      narrow.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.2,
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const active = FEATURES[state.active];
  const media = mediaFor(active.anchor);
  const running = visible && !reduced && !userPaused;

  // Playback + progress. Videos report their own position; a still runs on a
  // wall clock. Either way the bar reads 0 → 1 over the clip and the next tab
  // takes over at the end (or the clip starts over when the tab is held).
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts per tab, hold, and stacking (which remounts the panel)
  useEffect(() => {
    setProgress(0);
    const video = videoRef.current;
    if (!running) {
      video?.pause();
      return;
    }
    let raf = 0;
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {
        // Autoplay refused (e.g. data saver): the poster stays up.
      });
      const onEnded = () => {
        if (state.held) {
          video.currentTime = 0;
          video.play().catch(() => {});
        } else {
          dispatch({ type: 'next' });
        }
      };
      video.addEventListener('ended', onEnded);
      const frame = () => {
        if (video.duration) setProgress(video.currentTime / video.duration);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(raf);
        video.removeEventListener('ended', onEnded);
        video.pause();
      };
    }
    let start = performance.now();
    const frame = (now: number) => {
      const p = (now - start) / STILL_MS;
      if (p >= 1) {
        if (state.held) {
          start = now;
        } else {
          dispatch({ type: 'next' });
          return;
        }
      }
      setProgress(Math.min(1, p));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, state.active, state.held, stacked]);

  const barFor = (index: number) => {
    if (index !== state.active) return 0;
    if (state.held || reduced) return 1;
    return progress;
  };

  const panel = (className: string) => (
    <div className={`${styles.panel} ${className}`} data-troupe="board-panel">
      {media?.type === 'video' ? (
        <video
          key={media.src}
          ref={videoRef}
          className={styles.media}
          muted
          playsInline
          preload="metadata"
          poster={media.poster}
          aria-label={media.alt}
        >
          {media.srcSmall && (
            <source src={media.srcSmall} type="video/mp4" media="(max-width: 720px)" />
          )}
          <source src={media.src} type="video/mp4" />
        </video>
      ) : media?.type === 'image' ? (
        // biome-ignore lint/performance/noImgElement: Static product screenshot (static export, unoptimized images)
        <img key={media.src} className={styles.mediaStill} src={media.src} alt={media.alt} />
      ) : null}
      {!reduced && (
        <button
          type="button"
          className={styles.pauseToggle}
          onClick={() => setUserPaused((value) => !value)}
          aria-label={userPaused ? 'Play' : 'Pause'}
        >
          {userPaused ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}
        </button>
      )}
    </div>
  );

  return (
    <section
      className={`${landing.showcaseSection} ${styles.section}`}
      ref={sectionRef}
      data-reveal
      data-troupe-section="board"
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
                <div key={feature.anchor} className={styles.tabItem}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`${styles.tab}${on(isActive, styles.tabActive)}`}
                    onClick={() => dispatch({ type: 'select', index })}
                  >
                    <span className={styles.tabTitle}>{feature.label}</span>
                    <span className={styles.tabBody}>{feature.body}</span>
                    <span className={styles.track} aria-hidden="true">
                      <span
                        className={styles.fill}
                        style={{ transform: `scaleX(${barFor(index)})` }}
                      />
                    </span>
                  </button>
                  {/* Beside the title, outside the tab button (no nested
                      interactive elements). */}
                  <LandingLink
                    page="board"
                    anchor={feature.anchor}
                    placement="home-section"
                    className={styles.learnMore}
                  >
                    Learn more
                    <span className={styles.srOnly}> about {feature.label.toLowerCase()}</span>
                  </LandingLink>
                  {/* One panel only: under the active tab when stacked. */}
                  {stacked && isActive && panel(styles.panelInline)}
                </div>
              );
            })}
          </div>
        </div>
        {!stacked && panel('')}
      </div>
    </section>
  );
}
