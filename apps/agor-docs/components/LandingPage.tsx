'use client';

import { HOME_HERO } from './heroCopy';
import styles from './LandingPage.module.css';
import { BoardSection } from './landing/BoardSection';
import { CommandCenterSection } from './landing/CommandCenterSection';
import { GovernanceSection } from './landing/GovernanceSection';
import { LandingHero } from './landing/LandingHero';
import { LandingLink } from './landing/LandingLink';
import { LandingShell } from './landing/LandingShell';
import { MultiplayerSection } from './landing/MultiplayerSection';
import { ProblemSection } from './landing/ProblemSection';
import { LANDING_PAGES } from './landing/pages';
import { RosterSection } from './landing/RosterSection';
import { TeammatesSection } from './landing/TeammatesSection';

/**
 * Hub page. The hero's links fan out to each landing page (most visitors
 * never scroll, so those clicks show which stories matter); below it, each
 * section is a sampler that hands off to its landing page.
 */
export function LandingPage() {
  return (
    <LandingShell ctaPrefix="landing">
      <LandingHero badge="Multiplayer AI" copy={HOME_HERO} ctaPlacement="landing-hero">
        <nav className={styles.heroHub} aria-label="Explore Agor">
          {LANDING_PAGES.map((page) => (
            <LandingLink
              key={page.id}
              page={page.id}
              placement="home-hero"
              className={styles.heroHubLink}
            >
              {page.navLabel}
            </LandingLink>
          ))}
        </nav>
      </LandingHero>
      <ProblemSection />
      <BoardSection sampler />
      <TeammatesSection sampler />
      <CommandCenterSection sampler />
      <GovernanceSection sampler />
      <MultiplayerSection sampler />
      <RosterSection sampler />
    </LandingShell>
  );
}
