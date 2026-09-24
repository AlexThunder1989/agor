'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import styles from '../LandingPage.module.css';
import { LearnMore } from './LandingLink';

// Spatial boards, rich sessions, and the message gateway are deliberately
// absent — the "See the work and shape it together" showcase already tells
// those stories with video.
const productPreviews = [
  {
    title: 'Persistent teammates',
    body: 'Give long-lived helpers memory, skills, schedules, and team-wide reach beyond one-off prompts.',
    image: '/screenshots/teammates-list.png',
    href: '/guide/teammates',
  },
  {
    title: 'Scheduler',
    body: 'Run standups, audits, digests, reports, and teammate heartbeats without waiting to be asked.',
    image: '/screenshots/scheduler-modal.png',
    href: '/guide/scheduler',
  },
  {
    title: 'Artifacts',
    body: 'Let agents render live dashboards, mockups, calculators, and tools directly on the board.',
    image: '/images/artifacts-hero.png',
    href: '/guide/artifacts',
  },
  {
    title: 'Built-in knowledge base',
    body: 'Give your team and its agents one shared place for decisions, runbooks, prompts, memory, and reusable context.',
    image: '/images/knowledge-hero.png',
    href: '/guide/knowledge',
  },
  {
    title: 'Branch environments',
    body: 'Start, stop, health-check, and inspect logs for every branch environment without port fights.',
    image: '/screenshots/env_configuration.png',
    href: '/guide/environment-configuration',
  },
  {
    title: 'MCP-native control',
    body: 'Anything a user can do in Agor, an agent can do too: spawn peers, move work, schedule runs, and report back.',
    image: '/screenshots/mcp_environment.png',
    href: '/guide/internal-mcp',
  },
];

export function CommandCenterSection({ sampler = false }: { sampler?: boolean }) {
  const [activeSurface, setActiveSurface] = useState(0);
  const [scrollySurface, setScrollySurface] = useState(0);
  const scrollyTrackRef = useRef<HTMLDivElement>(null);
  // Native swipe carousel (phones): .scrollyTrack is itself the horizontally
  // scrollable element (CSS scroll-snap), so a flick moves it and vertical
  // page scroll is never touched — no pinning, no artificial section height.
  // This listener just keeps `scrollySurface` (status line, dots) in sync
  // with wherever the user's swipe lands, debounced to the settle rather
  // than firing on every scroll frame.
  useEffect(() => {
    const track = scrollyTrackRef.current;
    if (!track) {
      return;
    }

    const media = window.matchMedia('(max-width: 720px)');
    let settleTimeout: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      if (!media.matches) {
        return;
      }
      clearTimeout(settleTimeout);
      settleTimeout = setTimeout(() => {
        const width = track.clientWidth;
        if (!width) {
          return;
        }
        const index = Math.round(track.scrollLeft / width);
        setScrollySurface(Math.min(productPreviews.length - 1, Math.max(0, index)));
      }, 100);
    };

    track.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', onScroll);
      clearTimeout(settleTimeout);
    };
  }, []);

  return (
    <section className={styles.productShowcase} data-reveal>
      <div className={styles.sectionHeader}>
        <span className={styles.eyebrow}>Stay sane with a lot of agents</span>
        <h2>
          A <span className={styles.headingStrong}>command center</span> for{' '}
          <span className={styles.headingAccent}>agent work</span>
        </h2>
      </div>
      {/* Desktop: same carousel grammar as the showcase above — tab pills,
          chrome frame, sliding track, arrows, click-the-shot-to-advance.
          Track/slide widths are inline because they depend on the entry
          count. Phones hide this and use the scroll-locked treatment
          below. */}
      <div className={styles.surfaceExplorer} data-reveal>
        <div className={styles.showcaseTabs}>
          {productPreviews.map((preview, index) => (
            <button
              type="button"
              key={preview.title}
              className={
                index === activeSurface
                  ? `${styles.showcaseTab} ${styles.showcaseTabActive}`
                  : styles.showcaseTab
              }
              aria-pressed={index === activeSurface}
              onClick={() => setActiveSurface(index)}
            >
              {preview.title}
            </button>
          ))}
        </div>
        <div className={styles.showcaseFrame}>
          <div className={styles.showcaseViewport}>
            <div
              className={styles.showcaseTrack}
              style={
                {
                  width: `${productPreviews.length * 100}%`,
                  '--showcase-transform': `translateX(-${activeSurface * (100 / productPreviews.length)}%)`,
                } as CSSProperties
              }
            >
              {productPreviews.map((preview, index) => (
                <div
                  className={styles.surfaceSlide}
                  key={preview.title}
                  style={{ width: `${100 / productPreviews.length}%` }}
                >
                  <div className={styles.surfaceInfo}>
                    <div>
                      <h3>{preview.title}</h3>
                      <p>{preview.body}</p>
                    </div>
                    <Link href={preview.href} className={styles.secondaryButton}>
                      Learn more →
                    </Link>
                  </div>
                  <button
                    type="button"
                    className={styles.surfaceShotButton}
                    aria-label="Next capability"
                    onClick={() => setActiveSurface((index + 1) % productPreviews.length)}
                  >
                    {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                    <img
                      className={styles.surfaceShot}
                      src={preview.image}
                      alt={`Screenshot of ${preview.title} in Agor`}
                      loading={index === 0 ? 'eager' : 'lazy'}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            aria-label="Previous capability"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowLeft}`}
            onClick={() =>
              setActiveSurface(
                (activeSurface + productPreviews.length - 1) % productPreviews.length
              )
            }
          >
            <ChevronLeft size={22} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next capability"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowRight}`}
            onClick={() => setActiveSurface((activeSurface + 1) % productPreviews.length)}
          >
            <ChevronRight size={22} aria-hidden />
          </button>
        </div>
      </div>
      {/* Phone treatment: cards swipe natively via CSS scroll-snap on
          .scrollyTrack — a normal-height section, so vertical page scroll
          is never intercepted. */}
      <div className={styles.surfaceScrolly}>
        <div className={styles.scrollySticky}>
          <div className={styles.scrollyStatus}>
            {/* Same treatment as the showcase status: numeric ornament is
                hidden from screen readers in favor of plain wording. */}
            <span className={styles.scrollyStatusCount} aria-hidden="true">
              {String(scrollySurface + 1).padStart(2, '0')} /{' '}
              {String(productPreviews.length).padStart(2, '0')}
            </span>
            <span className={styles.srOnly}>
              Slide {scrollySurface + 1} of {productPreviews.length}
            </span>
            <span className={styles.scrollyStatusTitle}>
              {productPreviews[scrollySurface].title}
            </span>
          </div>
          <div className={styles.scrollyTrack} ref={scrollyTrackRef}>
            {productPreviews.map((preview) => (
              <article
                key={preview.title}
                className={styles.scrollyCard}
                style={{ width: `${100 / productPreviews.length}%` }}
              >
                {/* biome-ignore lint/performance/noImgElement: Static product screenshot */}
                <img
                  className={styles.scrollyShot}
                  src={preview.image}
                  alt={`Screenshot of ${preview.title} in Agor`}
                  loading="lazy"
                />
                <h3>{preview.title}</h3>
                <p>{preview.body}</p>
              </article>
            ))}
          </div>
          <div className={styles.scrollyDots} aria-hidden="true">
            {productPreviews.map((preview, index) => (
              <span
                key={preview.title}
                className={
                  index === scrollySurface
                    ? `${styles.scrollyDot} ${styles.scrollyDotActive}`
                    : styles.scrollyDot
                }
              />
            ))}
          </div>
        </div>
      </div>
      {sampler && <LearnMore page="command-center" />}
    </section>
  );
}
