'use client';

import Link from 'next/link';
import { trackEvent } from '../../lib/analytics';
import landing from '../LandingPage.module.css';
import styles from './AgentRoster.module.css';
import { LandingShell } from './LandingShell';
import { RosterSection } from './RosterSection';
import { ROSTER } from './roster';

const TEAMMATE_REPO_URL = 'https://github.com/preset-io/agor-teammate';

// Written-up members first, so the listings open on the richest stories.
const LISTINGS = [...ROSTER].sort(
  (a, b) => Number(Boolean(b.abstract)) - Number(Boolean(a.abstract))
);

/**
 * /agent-roster: the AI teammates Preset runs on its own Agor instance, as
 * worked examples of what a team can raise. Intro on the framework they're
 * built from, the radar, then one listing per teammate.
 */
export function AgentRoster() {
  return (
    <LandingShell ctaPrefix="agent-roster-page">
      <section className={styles.intro} data-reveal>
        <span className={landing.eyebrow}>The Preset agent roster</span>
        <h1 className={styles.title}>
          More <span className={landing.headingAccent}>teammates</span> than{' '}
          <span className={landing.headingStrong}>people</span>
        </h1>
        <p className={styles.lead}>
          <span className={styles.leadStrong}>
            On Preset’s internal Slack, AI teammates now outnumber the humans.
          </span>{' '}
          These are some of the ones we run on our own Agor instance: deal desk, legal, market
          research, bug fixing, security patches, data engineering, and more. They’re examples of
          the use cases we’re tackling, not a catalog. Your team can raise whichever teammates it
          needs.
        </p>
        <div className={styles.framework}>
          <h2>How a teammate is defined</h2>
          <p>
            Each one is built on the{' '}
            <Link href={TEAMMATE_REPO_URL} target="_blank" rel="noopener noreferrer">
              agor-teammate framework
            </Link>
            , inspired by OpenClaw. A teammate lives on its own branch with a few plain markdown
            files: <code>SOUL.md</code> for its values and voice, <code>IDENTITY.md</code> for its
            name, board, and Knowledge namespace, <code>USER.md</code> for who it works with,{' '}
            <code>BOOT.md</code> for its startup checklist, and an optional{' '}
            <code>HEARTBEAT.md</code> for recurring work. Long-term memory lives in Agor Knowledge,
            where the team can read and correct it. A new teammate onboards through its first
            conversation, working toward a real result.
          </p>
          <ul className={styles.frameworkLinks}>
            <li>
              <Link href="/guide/first-teammate">
                Raise your first teammate <span aria-hidden="true">→</span>
              </Link>
            </li>
            <li>
              <Link href="/teammates">
                How AI teammates work <span aria-hidden="true">→</span>
              </Link>
            </li>
            <li>
              <Link href="/blog/agent-modeling-101">
                Agent modeling 101 <span aria-hidden="true">→</span>
              </Link>
            </li>
          </ul>
        </div>
      </section>

      <RosterSection />

      <section className={styles.listings} aria-labelledby="roster-listings" data-reveal>
        <h2 id="roster-listings" className={styles.listingsTitle}>
          Meet the <span className={landing.headingAccent}>roster</span>
        </h2>
        <div className={styles.grid}>
          {LISTINGS.map((member) => (
            <article key={member.id} id={member.id} className={styles.card}>
              <div className={styles.cardHead}>
                <span className={styles.icon} aria-hidden="true">
                  <member.icon size={18} />
                </span>
                <div>
                  <h3>{member.name}</h3>
                  <p className={styles.role}>{member.role}</p>
                </div>
              </div>
              {member.abstract ? <p className={styles.abstract}>{member.abstract}</p> : null}
              <p className={styles.meta}>{member.meta}</p>
              {member.story ? (
                <Link
                  href={member.story.href}
                  className={styles.storyLink}
                  {...(member.story.external
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  onClick={() => trackEvent('roster_story_click', { member: member.name })}
                >
                  {member.story.label} <span aria-hidden="true">→</span>
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </LandingShell>
  );
}
