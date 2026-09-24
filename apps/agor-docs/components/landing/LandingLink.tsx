'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from '../LandingPage.module.css';
import { type LandingPageId, landingPage } from './pages';

interface LandingLinkProps {
  page: LandingPageId;
  /** Where the link sits, e.g. `home-hero` or `home-section`. */
  placement: string;
  className?: string;
  children: ReactNode;
}

/** Internal link to a landing page that records which page visitors pick. */
export function LandingLink({ page, placement, className, children }: LandingLinkProps) {
  const { href } = landingPage(page);
  return (
    <Link
      href={href}
      className={className}
      onClick={() => trackEvent('landing_page_click', { landing_page: page, placement })}
    >
      {children}
    </Link>
  );
}

/** "Learn more" link a home-page sampler section uses to hand off to its landing page. */
export function LearnMore({ page }: { page: LandingPageId }) {
  return (
    <div className={styles.learnMore}>
      <LandingLink page={page} placement="home-section" className={styles.learnMoreLink}>
        Explore {landingPage(page).navLabel} <span aria-hidden="true">→</span>
      </LandingLink>
    </div>
  );
}
