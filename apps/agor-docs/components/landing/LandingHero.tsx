'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { GITHUB_REPO_URL } from '../../lib/links';
import { CloudCtaLink } from '../CloudCtaLink';
import { type HeroCopy, HighlightedText } from '../heroCopy';
import styles from '../LandingPage.module.css';
import { useFitText } from '../useFitText';
import { DemoButton } from './DemoButton';

function GitHubIcon() {
  return (
    <svg className={styles.githubIcon} aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

interface LandingHeroProps {
  badge: string;
  copy: HeroCopy;
  /** Attribution slug for the hero's Cloud CTA. */
  ctaPlacement: string;
  /** Extra content under the action buttons (the home page's hub links). */
  children?: ReactNode;
}

export function LandingHero({ badge, copy, ctaPlacement, children }: LandingHeroProps) {
  const h1Ref = useFitText<HTMLHeadingElement>([copy.headline]);
  const h2Ref = useFitText<HTMLHeadingElement>([copy.subheadline]);

  return (
    <div className={styles.heroBanner}>
      {/* Looping product demo as the hero backdrop. Sources are a viewport
          ladder — browsers pick the first matching media query. Falls back
          to the poster frame under prefers-reduced-motion (CSS hides the
          video element; the poster is the layer's background image). */}
      <div className={styles.heroVideo} aria-hidden="true">
        <video autoPlay muted loop playsInline preload="auto" poster="/videos/agor-hero-poster.jpg">
          <source src="/videos/agor-hero-540.mp4" type="video/mp4" media="(max-width: 720px)" />
          <source src="/videos/agor-hero-720.mp4" type="video/mp4" media="(max-width: 1280px)" />
          <source src="/videos/agor-hero.mp4" type="video/mp4" />
        </video>
      </div>
      <section className={styles.heroSection}>
        <div className={styles.heroCopy} data-reveal>
          <p className={styles.heroBadge}>{badge}</p>
          <h1 ref={h1Ref} className={styles.heroForcedBreak}>
            <HighlightedText text={copy.headline} />
          </h1>
          <h2 ref={h2Ref} className={styles.heroForcedBreak}>
            <HighlightedText text={copy.subheadline} />
          </h2>
          <div className={styles.heroActions}>
            <CloudCtaLink placement={ctaPlacement} className={styles.primaryButton} />
            <DemoButton className={styles.secondaryButton}>Book a demo</DemoButton>
            <Link href="/guide/getting-started" className={styles.secondaryButton}>
              Install locally
            </Link>
            <Link
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.secondaryButton}
            >
              <GitHubIcon />
              Star us on GitHub
            </Link>
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}
