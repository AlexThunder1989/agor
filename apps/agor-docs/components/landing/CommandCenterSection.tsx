'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import styles from '../LandingPage.module.css';
import { LandingLink, LearnMore } from './LandingLink';
import { SectionHeroActions } from './SectionHeroActions';

// The builder's working surface, in the order a run of many agents needs it:
// organize, branch, fan out, share context, then build and run. Boards,
// sessions, and the gateway are the /board story; teammates and schedules are
// the /teammates story. Each slide's anchor is its detail block on this page.
const productPreviews = [
  {
    title: 'Zones & prompts',
    body: 'Drop a branch into a zone to trigger its reusable prompt, so a review or release check starts the same way every time.',
    image: '/screenshots/zone-trigger.png',
    anchor: 'zones-and-prompts',
  },
  {
    title: 'Session trees',
    body: 'Fork to try an alternative, or spawn focused child sessions, and keep the whole thread in one tree.',
    image: '/screenshots/security-review-fanout.png',
    anchor: 'session-trees',
  },
  {
    title: 'Parallel agents',
    body: 'Fan work out to several agents at once, then review the results together on the same branch card.',
    image: '/screenshots/parallel-board-5-sessions.png',
    anchor: 'parallel-agents',
  },
  {
    title: 'Knowledge base',
    body: 'Give your team and its agents one shared place for decisions, runbooks, prompts, and reusable context.',
    image: '/images/knowledge-hero.png',
    anchor: 'knowledge',
  },
  {
    title: 'Branch environments',
    body: 'Start, stop, health-check, and read logs for every branch environment without port fights.',
    image: '/screenshots/env_configuration.png',
    anchor: 'environments',
  },
  {
    title: 'Artifacts',
    body: 'Let agents render live dashboards, mockups, and tools right on the board.',
    image: '/images/artifacts-hero.png',
    anchor: 'artifacts',
  },
  {
    title: 'Agor MCP',
    body: 'Anything you can do in Agor, an agent can do too: spawn peers, move work, schedule runs, and report back.',
    image: '/screenshots/mcp_environment.png',
    anchor: 'mcp',
  },
];

export function CommandCenterSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** Render as its landing page's hero: h1 heading, CTA row, first-screen height. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
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
    <section
      className={hero ? `${styles.productShowcase} ${styles.sectionHero}` : styles.productShowcase}
      data-reveal
    >
      <div className={styles.sectionHeader}>
        <span className={styles.eyebrow}>Stay sane with a lot of agents</span>
        <Heading>
          A <span className={styles.headingStrong}>command center</span> for{' '}
          <span className={styles.headingAccent}>agent work</span>
        </Heading>
        {hero && <SectionHeroActions page="command-center" align="start" />}
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
                    <LandingLink
                      page="command-center"
                      anchor={preview.anchor}
                      placement={sampler ? 'home-section' : 'command-center-page-carousel'}
                      className={styles.secondaryButton}
                    >
                      Learn more →
                    </LandingLink>
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
