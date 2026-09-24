'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import Aurora from '../Aurora/Aurora';
import styles from '../LandingPage.module.css';
import { LearnMore } from './LandingLink';

// "See the work and shape it together" carousel. Each slide is a short loop-perfect
// demo video rendered by the demo-videos pipeline (apps/agor-docs/demo-videos);
// the poster doubles as the reduced-motion / JS-off fallback.
const showcaseSlides = [
  {
    label: 'Multiplayer presence',
    blurb:
      'Your team and its agents share one board: live cursors, shared sessions, queued follow-ups.',
    video: '/videos/showcase-multiplayer.mp4',
    videoSmall: '/videos/showcase-multiplayer-540.mp4',
    poster: '/videos/showcase-multiplayer-poster.jpg',
  },
  {
    label: 'Spatial boards',
    blurb: 'Arrange branches, zones, sessions, and teammates on one spatial canvas.',
    video: '/videos/showcase-boards.mp4',
    videoSmall: '/videos/showcase-boards-540.mp4',
    poster: '/videos/showcase-boards-poster.jpg',
  },
  {
    label: 'Rich agent sessions',
    blurb: 'Follow an agent’s tool calls, decisions, and handoffs, and bring a colleague in.',
    video: '/videos/showcase-sessions.mp4',
    videoSmall: '/videos/showcase-sessions-540.mp4',
    poster: '/videos/showcase-sessions-poster.jpg',
  },
  {
    label: 'Message gateway',
    blurb:
      'Work with agents from Slack, GitHub, and the threads where your team already talks. No board required.',
    video: '/videos/showcase-gateway.mp4',
    videoSmall: '/videos/showcase-gateway-540.mp4',
    poster: '/videos/showcase-gateway-poster.jpg',
  },
];

export function BoardSection({ sampler = false }: { sampler?: boolean }) {
  const [activeShot, setActiveShot] = useState(0);
  const showcaseViewportRef = useRef<HTMLDivElement>(null);
  const slideVideoRefs = useRef<Array<HTMLVideoElement | null>>([]);
  // Showcase carousel playback gating: only the active slide's video plays;
  // off-screen slides pause (four loops on one page would otherwise decode
  // simultaneously forever). Under prefers-reduced-motion nothing plays — the
  // CSS hides the videos and the poster background shows instead.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    slideVideoRefs.current.forEach((video, index) => {
      if (!video) {
        return;
      }
      if (index === activeShot) {
        video.play().catch(() => {
          // Autoplay can be rejected (e.g. data-saver); the poster still shows.
        });
      } else {
        video.pause();
      }
    });
  }, [activeShot]);

  // Same native-swipe treatment for the showcase reel, plus the reverse
  // direction: the phone-only arrow buttons still call setActiveShot, so
  // scroll the viewport to match whenever that state changes elsewhere.
  useEffect(() => {
    const viewport = showcaseViewportRef.current;
    if (!viewport) {
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
        const width = viewport.clientWidth;
        if (!width) {
          return;
        }
        const index = Math.round(viewport.scrollLeft / width);
        setActiveShot(Math.min(showcaseSlides.length - 1, Math.max(0, index)));
      }, 100);
    };

    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', onScroll);
      clearTimeout(settleTimeout);
    };
  }, []);

  useEffect(() => {
    const viewport = showcaseViewportRef.current;
    if (!viewport || !window.matchMedia('(max-width: 720px)').matches) {
      return;
    }
    const target = activeShot * viewport.clientWidth;
    if (Math.abs(viewport.scrollLeft - target) > 2) {
      viewport.scrollTo({ left: target, behavior: 'smooth' });
    }
  }, [activeShot]);

  return (
    <section className={styles.showcaseSection} data-reveal>
      {/* Section divider: the docs pages' mint aurora as a thin curtain
          hanging from the seam with the problem section. */}
      <div className={styles.showcaseDivider} aria-hidden="true">
        <Aurora
          colorStops={['#2e9a92', '#34e6c4', '#7ad9ff']}
          amplitude={0.9}
          blend={1}
          speed={0.6}
        />
      </div>
      {/* On phones the section pins and scroll steps through the slides
          (same scroll-locked treatment as the surface carousel below);
          this wrapper is the sticky stage there and a plain div on
          desktop. */}
      <div className={styles.showcaseSticky}>
        <div className={styles.showcaseHeader}>
          <div className={styles.sectionHeader}>
            <h2>
              See the work and <span className={styles.headingStrong}>shape</span> it{' '}
              <span className={styles.headingAccent}>together</span>
            </h2>
          </div>
          <div className={styles.showcaseTabs}>
            {showcaseSlides.map((slide, index) => (
              <button
                type="button"
                key={slide.label}
                className={
                  index === activeShot
                    ? `${styles.showcaseTab} ${styles.showcaseTabActive}`
                    : styles.showcaseTab
                }
                aria-pressed={index === activeShot}
                onClick={() => setActiveShot(index)}
              >
                {slide.label}
              </button>
            ))}
          </div>
        </div>
        {/* Phone-only status line — mirrors the surface carousel below
            (tab pills hide on phones; this is the slide indicator). */}
        <div className={styles.showcaseStatus}>
          {/* The "01 / 04" ornament reads poorly aloud; screen readers get a
              plain "Slide 1 of 4" instead. */}
          <span className={styles.scrollyStatusCount} aria-hidden="true">
            {String(activeShot + 1).padStart(2, '0')} /{' '}
            {String(showcaseSlides.length).padStart(2, '0')}
          </span>
          <span className={styles.srOnly}>
            Slide {activeShot + 1} of {showcaseSlides.length}
          </span>
          <span className={styles.scrollyStatusTitle}>{showcaseSlides[activeShot].label}</span>
        </div>
        <div className={styles.showcaseFrame}>
          <div className={styles.showcaseViewport} ref={showcaseViewportRef}>
            {/* Track is 400% wide with 25% slides on desktop; phones scroll it
                natively instead (see .showcaseTrack's phone override). Keep
                the 25%/400% math in sync with showcaseSlides.length. */}
            <div
              className={styles.showcaseTrack}
              style={
                {
                  '--showcase-transform': `translateX(-${activeShot * 25}%)`,
                } as CSSProperties
              }
            >
              {showcaseSlides.map((slide, index) => (
                <div className={styles.showcaseSlide} key={slide.label}>
                  {/* Poster is the frame's background image so it shows under
                    prefers-reduced-motion (CSS hides the video) and with JS
                    off (no play() call ever fires). Only the first slide
                    preloads — four eager mp4s (~5MB) is real weight on a
                    phone; play() on the other slides triggers their fetch
                    when they're actually activated. */}
                  <div
                    className={styles.slideVideoFrame}
                    style={{ backgroundImage: `url(${slide.poster})` }}
                  >
                    <video
                      ref={(element) => {
                        slideVideoRefs.current[index] = element;
                      }}
                      className={styles.slideVideo}
                      muted
                      loop
                      playsInline
                      preload={index === 0 ? 'auto' : 'none'}
                      poster={slide.poster}
                      aria-label={slide.label}
                    >
                      <source src={slide.videoSmall} type="video/mp4" media="(max-width: 720px)" />
                      <source src={slide.video} type="video/mp4" />
                    </video>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* Invisible click layer: clicking the video advances the reel
              (arrows sit above it at a higher z-index). Hidden on phones,
              where scroll drives the carousel. Mouse-only affordance — the
              visible arrows are the accessible controls, so this stays out
              of the tab order and the accessibility tree. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={styles.frameAdvance}
            onClick={() => setActiveShot((activeShot + 1) % showcaseSlides.length)}
          />
          <button
            type="button"
            aria-label="Previous example"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowLeft}`}
            onClick={() =>
              setActiveShot((activeShot + showcaseSlides.length - 1) % showcaseSlides.length)
            }
          >
            <ChevronLeft size={22} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next example"
            className={`${styles.showcaseArrow} ${styles.showcaseArrowRight}`}
            onClick={() => setActiveShot((activeShot + 1) % showcaseSlides.length)}
          >
            <ChevronRight size={22} aria-hidden />
          </button>
        </div>
        {/* Phone-only: header + blurb below the video (mirrors the surface
            carousel's card text), with matching dots. */}
        <div className={styles.showcaseSlideInfo}>
          <h3>{showcaseSlides[activeShot].label}</h3>
          <p>{showcaseSlides[activeShot].blurb}</p>
        </div>
        <div className={styles.showcaseDots} aria-hidden="true">
          {showcaseSlides.map((slide, index) => (
            <span
              key={slide.label}
              className={
                index === activeShot
                  ? `${styles.scrollyDot} ${styles.scrollyDotActive}`
                  : styles.scrollyDot
              }
            />
          ))}
        </div>
      </div>
      {sampler && <LearnMore page="board" />}
    </section>
  );
}
