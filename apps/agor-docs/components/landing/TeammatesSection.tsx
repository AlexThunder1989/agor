'use client';

import {
  Blocks,
  Brain,
  CalendarClock,
  Hash,
  type LucideIcon,
  MessagesSquare,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AI_ENABLEMENT_POST_URL } from '../../lib/links';
import styles from '../LandingPage.module.css';
import Orb from '../Orb/Orb';
import { LandingLink, LearnMore } from './LandingLink';
import { SectionHeroActions } from './SectionHeroActions';

const featureCards: Array<{
  title: string;
  body: string;
  /** Detail block on /teammates. */
  anchor: string;
  icon: LucideIcon;
}> = [
  {
    title: 'Shared memory',
    icon: Brain,
    body: 'Teammates keep durable notes in your team’s shared knowledge base, where people and agents can search and build on them.',
    anchor: 'memory',
  },
  {
    title: 'Skills + MCP',
    icon: Blocks,
    body: 'Package repeatable workflows as skills and connect teammates to the MCP servers your team already trusts.',
    anchor: 'skills-and-mcp',
  },
  {
    title: 'Conversational onboarding',
    icon: MessagesSquare,
    body: 'Teach a teammate by talking to it. Anyone on the team can refine it, and the useful parts become reusable context.',
    anchor: 'onboarding',
  },
  {
    title: 'Where your team works',
    icon: Hash,
    body: 'Reach teammates from Slack, GitHub, or wherever work already happens through gateway channels.',
    anchor: 'channels',
  },
  {
    title: 'Scheduled agency',
    icon: CalendarClock,
    body: 'Run heartbeats, daily standups, audits, digests, or longer workflows without waiting for a prompt.',
    anchor: 'schedules',
  },
  {
    title: 'Identity + boundaries',
    icon: SlidersHorizontal,
    body: 'Define each teammate’s purpose, voice, and level of agency, so it knows how bold to be and when to ask first.',
    anchor: 'identity',
  },
];

export function TeammatesSection({
  sampler = false,
  hero = false,
}: {
  sampler?: boolean;
  /** Render as its landing page's hero: h1 heading, CTA row, first-screen height. */
  hero?: boolean;
}) {
  const Heading = hero ? 'h1' : 'h2';
  const [activeFeature, setActiveFeature] = useState(0);
  const placement = sampler ? 'home-section' : 'teammates-page-ring';

  return (
    <section
      className={
        hero ? `${styles.workspaceSection} ${styles.sectionHero}` : styles.workspaceSection
      }
      data-reveal
    >
      <div className={styles.workspaceCopy}>
        <span className={styles.eyebrow}>Build on what your team teaches them</span>
        <Heading>
          Raise <span className={styles.headingAccent}>AI teammates</span> your whole{' '}
          <span className={styles.headingStrong}>team</span> can teach
        </Heading>
        <p>
          You shouldn’t have to start over every time. Give teammates memory, teach them skills,
          connect them to your tools, and bring them where your team works. People decide their
          scope and when they ask for help, and anyone can pick up where a colleague left off. What
          your{' '}
          <Link href={AI_ENABLEMENT_POST_URL} target="_blank" rel="noopener noreferrer">
            most AI-enabled people
          </Link>{' '}
          figure out becomes something the whole team can build on.
        </p>
        {hero && <SectionHeroActions page="teammates" align="start" />}
        {sampler && <LearnMore page="teammates" />}
      </div>
      <div className={styles.featureRing} data-reveal>
        <div className={styles.ringStage}>
          {/* ReactBits orb: its glowing rim threads through the node
              centers, replacing the old 1px dashed guide circle. Sized so
              the rim (~80% of the orb's half-width) lands on the 37.5%
              node radius. */}
          <div className={styles.ringOrb} aria-hidden="true">
            <Orb hue={41} hoverIntensity={0} rotateOnHover forceHoverState={false} />
          </div>
          {featureCards.map((feature, index) => {
            const angle = ((-90 + index * (360 / featureCards.length)) * Math.PI) / 180;
            const radius = 37.5; // percent of stage, from center to node center
            const left = 50 + radius * Math.cos(angle);
            const top = 50 + radius * Math.sin(angle);
            const isActive = index === activeFeature;
            return (
              <button
                type="button"
                key={feature.title}
                className={
                  isActive ? `${styles.ringNode} ${styles.ringNodeActive}` : styles.ringNode
                }
                style={{ left: `${left}%`, top: `${top}%` }}
                onMouseEnter={() => setActiveFeature(index)}
                onFocus={() => setActiveFeature(index)}
                onClick={() => setActiveFeature(index)}
                aria-pressed={isActive}
              >
                <span className={styles.ringNodeIcon} aria-hidden>
                  <feature.icon size={15} />
                </span>
                <span>{feature.title}</span>
              </button>
            );
          })}
          <div className={styles.ringHub}>
            <div className={styles.ringHubInner} key={activeFeature}>
              <p>{featureCards[activeFeature].body}</p>
              <LandingLink
                page="teammates"
                anchor={featureCards[activeFeature].anchor}
                placement={placement}
                className={styles.ringButton}
              >
                Learn more <span aria-hidden="true">→</span>
              </LandingLink>
            </div>
          </div>
        </div>
      </div>
      {/* Phone fallback for the ring (hover/click doesn't earn its keep on
          touch): every feature expanded in a scrollable divider list —
          icon left, content right, no interaction required. */}
      <div className={styles.featureList} data-reveal>
        {featureCards.map((feature) => (
          <article key={feature.title} className={styles.featureListItem}>
            <span className={styles.featureListIcon} aria-hidden>
              <feature.icon size={15} />
            </span>
            <div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <LandingLink
                page="teammates"
                anchor={feature.anchor}
                placement={placement}
                className={styles.featureListLink}
              >
                Learn more <span aria-hidden="true">→</span>
              </LandingLink>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
