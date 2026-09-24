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
import { LearnMore } from './LandingLink';

const featureCards: Array<{
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  icon: LucideIcon;
}> = [
  {
    title: 'Shared memory',
    icon: Brain,
    body: 'Each teammate gets a namespace in the knowledge base: semantically searchable, durable, and shared with the team.',
    href: '/guide/knowledge',
    linkLabel: 'Explore Knowledge',
  },
  {
    title: 'Skills + MCP',
    icon: Blocks,
    body: 'Package repeatable workflows as skills and connect teammates to the MCP servers your team already trusts.',
    href: '/guide/internal-mcp',
    linkLabel: 'See MCP control',
  },
  {
    title: 'Conversational onboarding',
    icon: MessagesSquare,
    body: 'Teach a teammate by talking to it. Anyone on the team can refine it, and the useful parts become reusable context.',
    href: '/guide/teammates',
    linkLabel: 'Read about Teammates',
  },
  {
    title: 'Where your team works',
    icon: Hash,
    body: 'Reach teammates from Slack, GitHub, or wherever work already happens through gateway channels.',
    href: '/guide/message-gateway',
    linkLabel: 'Open Message Gateway',
  },
  {
    title: 'Scheduled agency',
    icon: CalendarClock,
    body: 'Run heartbeats, daily standups, audits, digests, or longer workflows without waiting for a prompt.',
    href: '/guide/scheduler',
    linkLabel: 'Explore Scheduler',
  },
  {
    title: 'Identity + boundaries',
    icon: SlidersHorizontal,
    body: 'Define each teammate’s purpose, voice, and level of agency, so it knows how bold to be and when to ask first.',
    href: '/blog/agent-modeling-101',
    linkLabel: 'Agent modeling 101',
  },
];

export function TeammatesSection({ sampler = false }: { sampler?: boolean }) {
  const [activeFeature, setActiveFeature] = useState(0);

  return (
    <section className={styles.workspaceSection} data-reveal>
      <div className={styles.workspaceCopy}>
        <span className={styles.eyebrow}>Build on what your team teaches them</span>
        <h2>
          Raise <span className={styles.headingAccent}>AI teammates</span> your whole{' '}
          <span className={styles.headingStrong}>team</span> can teach
        </h2>
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
              <Link href={featureCards[activeFeature].href} className={styles.ringButton}>
                {featureCards[activeFeature].linkLabel} <span aria-hidden="true">→</span>
              </Link>
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
              <Link href={feature.href} className={styles.featureListLink}>
                {feature.linkLabel} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
