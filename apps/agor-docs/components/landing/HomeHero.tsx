'use client';

import { ArrowRight, ArrowUpRight, Check, Copy, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { trackEvent } from '../../lib/analytics';
import { GITHUB_REPO_URL } from '../../lib/links';
import { CloudCtaLink } from '../CloudCtaLink';
import { HighlightedText, HOME_HERO } from '../heroCopy';
import styles from '../LandingPage.module.css';
import { DemoButton } from './DemoButton';
import { LandingLink } from './LandingLink';
import { LANDING_PAGES } from './pages';

const INSTALL_COMMAND = 'npm install -g agor-live';

function GitHubIcon() {
  return (
    <svg
      className={styles.homeGithubIcon}
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => {
      setCopied(true);
      trackEvent('install_command_copy', { placement: 'home-hero' });
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <button
      type="button"
      className={styles.homeInstall}
      onClick={copy}
      aria-label={copied ? 'Copied install command' : `Copy install command: ${INSTALL_COMMAND}`}
    >
      <span className={styles.homeInstallPrompt} aria-hidden="true">
        $
      </span>
      {INSTALL_COMMAND}
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
    </button>
  );
}

/**
 * Home hero (design handoff 2a): the pitch over a full-bleed video, one
 * primary CTA plus a text link, a copyable install command, and the landing
 * pages as a quiet row along the bottom edge, so visitors who never scroll
 * still see a way in.
 */
export function HomeHero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);

  // Reduced motion or data saver: stay on the poster frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      ?.saveData;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || saveData) {
      video.pause();
      setPaused(true);
    } else {
      video.play().catch(() => setPaused(true));
    }
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setPaused(false));
    } else {
      video.pause();
      setPaused(true);
    }
  };

  return (
    <div className={styles.homeHero}>
      {/* Decorative loop; the poster is the layer's background image so it shows
          while loading, when paused, and under reduced motion. */}
      <div className={styles.homeHeroVideo} aria-hidden="true">
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="metadata"
          poster="/videos/agor-hero-poster.jpg"
        >
          <source src="/videos/agor-hero-540.mp4" type="video/mp4" media="(max-width: 720px)" />
          <source src="/videos/agor-hero-720.mp4" type="video/mp4" media="(max-width: 1280px)" />
          <source src="/videos/agor-hero.mp4" type="video/mp4" />
        </video>
      </div>
      <div className={styles.homeHeroScrim} aria-hidden="true" />

      <section className={styles.homePitch}>
        <p className={styles.homeBadge}>Multiplayer AI</p>
        <h1>
          <HighlightedText text={HOME_HERO.headline} />
        </h1>
        <p className={styles.homeSub}>
          <HighlightedText text={HOME_HERO.subheadline} />
        </p>
        <div className={styles.homeCtaRow}>
          <CloudCtaLink
            placement="landing-hero"
            className={styles.homePrimary}
            suffix={<ArrowRight size={18} aria-hidden />}
          />
          <DemoButton className={styles.homeTextLink}>
            Book a demo <ArrowUpRight size={16} aria-hidden />
          </DemoButton>
        </div>
        <div className={styles.homeInstallRow}>
          <InstallCommand />
          <span>or</span>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.homeGithub}
          >
            <GitHubIcon />
            Star on GitHub
          </a>
        </div>
      </section>

      <nav className={styles.homeRow} aria-label="Explore Agor">
        {LANDING_PAGES.map((page) => (
          <LandingLink
            key={page.id}
            page={page.id}
            placement="home-hero"
            className={styles.homeRowItem}
          >
            <span className={styles.homeRowLabel}>
              {page.navLabel}
              <ArrowRight size={14} aria-hidden />
            </span>
            <span className={styles.homeRowDesc}>{page.tagline}</span>
          </LandingLink>
        ))}
      </nav>

      <button
        type="button"
        className={styles.homeVideoToggle}
        onClick={togglePlayback}
        aria-label={paused ? 'Play background video' : 'Pause background video'}
      >
        {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
      </button>
    </div>
  );
}
