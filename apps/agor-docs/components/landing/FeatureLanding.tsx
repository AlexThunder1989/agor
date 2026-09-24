'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from '../LandingPage.module.css';
import { BoardSection } from './BoardSection';
import { CommandCenterSection } from './CommandCenterSection';
import { GovernanceSection } from './GovernanceSection';
import { LandingHero } from './LandingHero';
import { LandingLink } from './LandingLink';
import { LandingShell } from './LandingShell';
import { MultiplayerSection } from './MultiplayerSection';
import { LANDING_PAGES, type LandingPageId, landingPage } from './pages';
import { RosterSection } from './RosterSection';
import { TeammatesSection } from './TeammatesSection';

// The home-page section each landing page grows out of, in its full form.
const PAGE_SECTIONS: Record<LandingPageId, ReactNode> = {
  multiplayer: <MultiplayerSection />,
  board: <BoardSection />,
  teammates: (
    <>
      <TeammatesSection />
      <RosterSection />
    </>
  ),
  'command-center': <CommandCenterSection />,
  governance: <GovernanceSection />,
};

/** Spoke page: templated hero, the section in full, then docs and sibling pages. */
export function FeatureLanding({ page }: { page: LandingPageId }) {
  const entry = landingPage(page);
  const ctaPrefix = `${page}-page`;

  return (
    <LandingShell ctaPrefix={ctaPrefix}>
      <LandingHero badge={entry.badge} copy={entry.hero} ctaPlacement={`${ctaPrefix}-hero`} />
      {PAGE_SECTIONS[page]}
      <section className={styles.pageLinks} data-reveal>
        <div>
          <h2 className={styles.pageLinksTitle}>Go deeper in the docs</h2>
          <ul className={styles.pageLinksList}>
            {entry.docs.map((doc) => (
              <li key={doc.href}>
                <Link href={doc.href}>
                  {doc.label} <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={styles.pageLinksTitle}>Explore more of Agor</h2>
          <ul className={styles.pageLinksList}>
            {LANDING_PAGES.filter((other) => other.id !== page).map((other) => (
              <li key={other.id}>
                <LandingLink page={other.id} placement={`${ctaPrefix}-explore`}>
                  {other.navLabel} <span aria-hidden="true">→</span>
                </LandingLink>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </LandingShell>
  );
}
