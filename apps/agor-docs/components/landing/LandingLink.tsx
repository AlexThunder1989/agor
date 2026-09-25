'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from '../LandingPage.module.css';
import { type LandingPageId, landingPage } from './pages';

interface LandingLinkProps {
  page: LandingPageId;
  /** Detail block id on that page (see details/types.ts REQUIRED_ANCHORS). */
  anchor?: string;
  /** Where the link sits, e.g. `home-hero` or `home-section`. */
  placement: string;
  className?: string;
  children: ReactNode;
}

/** Internal link to a landing page that records which page (and block) visitors pick. */
export function LandingLink({ page, anchor, placement, className, children }: LandingLinkProps) {
  const { href } = landingPage(page);
  return (
    <Link
      href={anchor ? `${href}#${anchor}` : href}
      className={className}
      onClick={() =>
        trackEvent('landing_page_click', {
          landing_page: page,
          landing_anchor: anchor ?? '',
          placement,
        })
      }
    >
      {children}
    </Link>
  );
}

interface LearnMoreProps {
  page: LandingPageId;
  anchor?: string;
  label?: string;
}

/** Hand-off link from a home-page sampler section to its landing page. */
export function LearnMore({ page, anchor, label }: LearnMoreProps) {
  return (
    <div className={styles.learnMore}>
      <LandingLink
        page={page}
        anchor={anchor}
        placement="home-section"
        className={styles.learnMoreLink}
      >
        {label ?? `Explore ${landingPage(page).navLabel}`} <span aria-hidden="true">→</span>
      </LandingLink>
    </div>
  );
}
