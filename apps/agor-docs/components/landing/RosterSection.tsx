'use client';

import {
  Activity,
  Bug,
  ClipboardList,
  Code2,
  DoorOpen,
  DraftingCompass,
  Eye,
  Hammer,
  Handshake,
  type LucideIcon,
  Scale,
  Target,
  Telescope,
} from 'lucide-react';
import Link from 'next/link';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { trackEvent } from '../../lib/analytics';
import styles from '../LandingPage.module.css';
import { LearnMore } from './LandingLink';

// Meet the roster — real teammates from our own Agor instance (names and
// jobs are the genuine article), rendered as blips on the Roster Radar.
// `r`/`a` are polar coordinates (radius in radar units, angle in degrees)
// around the scope's center; `status`/`mem` feed the hover tooltip.
// Real teammates from the Preset Agor instance — names, jobs, and the meta
// line are the genuine article (usage pulled from instance analytics,
// 2026-07). `meta` is each agent's most interesting true fact.
const rosterMembers: Array<{
  icon: LucideIcon;
  name: string;
  role: string;
  meta: string;
  r: number;
  a: number;
  /** Blog post in the member's own words, when there is one. */
  story?: string;
}> = [
  {
    icon: Code2,
    name: 'AgorClaw',
    role: 'Main coding orchestrator, and the first teammate in the instance',
    meta: '55B tokens · 1,600+ tasks',
    r: 100,
    a: -90,
  },
  {
    icon: DraftingCompass,
    name: 'Preset Architect',
    role: 'Knows every repo and how they fit together',
    meta: 'weekly release health check',
    r: 170,
    a: -58,
  },
  {
    icon: Eye,
    name: 'Princeton',
    role: 'PR reviewer that learns from your human reviewers',
    meta: 'learns from review comments',
    r: 190,
    a: 4,
  },
  {
    icon: ClipboardList,
    name: 'Milchick',
    role: 'Chief-of-staff orchestrator',
    meta: 'Slack-native · nightly 9pm run',
    r: 135,
    a: -28,
  },
  {
    icon: Target,
    name: 'Peyton Manning',
    role: 'Sees the whole field, routes work to the right people',
    meta: 'labels RC tickets every 4h',
    r: 110,
    a: 44,
  },
  {
    icon: Activity,
    name: 'SRE',
    role: 'Datadog triage, tickets, and production fixes',
    meta: '3 daily crons',
    r: 155,
    a: 92,
  },
  {
    icon: Hammer,
    name: 'Telchar',
    role: 'Opens a ticket, branch, and PR per CVE',
    meta: 'Snyk-fed · never merges alone',
    r: 195,
    a: 138,
  },
  {
    icon: Scale,
    name: 'Saul',
    role: 'Legal, contracts, redlines expert',
    meta: 'Slack-native · on call for redlines',
    r: 145,
    a: 182,
  },
  {
    icon: Handshake,
    name: 'Blake',
    role: 'Deal desk, contracts, and order forms',
    meta: '@-mention him in Slack',
    r: 180,
    a: -134,
    story: '/blog/meet-blake',
  },
  {
    icon: DoorOpen,
    name: 'Hodor!',
    role: 'Agor’s own PM: issues, roadmap, ritual notes',
    meta: 'lives in #agor · attends rituals',
    r: 200,
    a: -158,
    story: '/blog/meet-hodor',
  },
  {
    icon: Telescope,
    name: 'Wendy',
    role: 'Competitive intelligence: who shipped what, and what it means',
    meta: 'daily market scan · Monday briefing',
    r: 210,
    a: -99,
    story: '/blog/meet-wendy-preset-ai-competitive-intelligence-analyst',
  },
  {
    icon: Bug,
    name: 'Bug Basher',
    role: 'Takes Apache Superset bugs from report to merged PR',
    meta: 'one branch per bug · tests first',
    r: 210,
    a: 60,
    story: '/blog/meet-bug-basher',
  },
];

// Radar scope is authored on a 560×560 grid (center 280,280); positions are
// expressed as percentages so the whole scope scales responsively. Values are
// rounded to a fixed precision — full-precision floats serialize differently
// between SSR and the client and trigger hydration mismatches.
const RADAR_SIZE = 560;

const radarPoint = (r: number, a: number): { x: number; y: number } => {
  const rad = (a * Math.PI) / 180;
  return {
    x: Number((((RADAR_SIZE / 2 + r * Math.cos(rad)) / RADAR_SIZE) * 100).toFixed(3)),
    y: Number((((RADAR_SIZE / 2 + r * Math.sin(rad)) / RADAR_SIZE) * 100).toFixed(3)),
  };
};

const radarPosition = (r: number, a: number): CSSProperties => {
  const { x, y } = radarPoint(r, a);
  return { left: `${x}%`, top: `${y}%` };
};

// Tooltip anchoring: clamp the card's center away from the scope's edge so it
// clears the circular overflow clip, and flip it below the blip for members in
// the top region (no headroom above). The arrow slides back over the blip via
// a container-query offset (cqw = 1% of the scope's width).
const TOOLTIP_CLAMP_PCT = 23;

const radarTooltip = (r: number, a: number): { style: CSSProperties; below: boolean } => {
  const { x, y } = radarPoint(r, a);
  const clampedX = Math.min(100 - TOOLTIP_CLAMP_PCT, Math.max(TOOLTIP_CLAMP_PCT, x));
  return {
    below: y < 40,
    style: {
      left: `${clampedX}%`,
      top: `${y}%`,
      '--tooltip-arrow-dx': `${Number((x - clampedX).toFixed(3))}cqw`,
    } as CSSProperties,
  };
};

export function RosterSection({ sampler = false }: { sampler?: boolean }) {
  const [hoveredMember, setHoveredMember] = useState<number | null>(null);
  const [radarInView, setRadarInView] = useState(false);
  const radarScopeRef = useRef<HTMLDivElement>(null);
  // Phones show the radar detail card as a fixed bottom overlay; fade it in
  // only while the radar itself is on screen so it never floats over
  // unrelated sections.
  useEffect(() => {
    const scope = radarScopeRef.current;
    if (!scope) {
      return;
    }
    // Ratio-based (not isIntersecting): the card retires as soon as most of
    // the radar has scrolled away, instead of lingering until the last pixel
    // exits underneath the next section.
    const observer = new IntersectionObserver(
      ([entry]) => setRadarInView(entry.intersectionRatio >= 0.35),
      { threshold: [0, 0.35] }
    );
    observer.observe(scope);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="roster" className={styles.rosterSection} data-reveal>
      <div className={styles.rosterCopy}>
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>Meet the Preset agent team</span>
          <h2>
            Teammates we <span className={styles.headingStrong}>raised</span>{' '}
            <span className={styles.headingAccent}>together</span>
          </h2>
        </div>
        <p className={styles.rosterBody}>
          A few examples from our own Agor instance today. Each has a name, a job, its own memory,
          and a team of people who teach it and keep it improving.
        </p>
        <p className={styles.rosterStatusLine}>
          <span className={styles.rosterStatusDot} aria-hidden="true" />
          <span>
            <span className={styles.hoverWord}>Hover</span>
            <span className={styles.tapWord}>Tap</span> to meet them
          </span>
        </p>
        {sampler && (
          <LearnMore page="teammates" anchor="roster" label="Meet the team behind them" />
        )}
      </div>
      <div className={styles.radarScope} ref={radarScopeRef}>
        <svg className={styles.radarSvg} viewBox="0 0 560 560" aria-hidden="true">
          <circle cx="280" cy="280" r="100" fill="none" stroke="rgba(94, 233, 208, 0.14)" />
          <circle cx="280" cy="280" r="190" fill="none" stroke="rgba(94, 233, 208, 0.12)" />
          <circle cx="280" cy="280" r="270" fill="none" stroke="rgba(94, 233, 208, 0.1)" />
          <line x1="280" y1="0" x2="280" y2="560" stroke="rgba(94, 233, 208, 0.07)" />
          <line x1="0" y1="280" x2="560" y2="280" stroke="rgba(94, 233, 208, 0.07)" />
        </svg>
        <div className={styles.radarSweep} aria-hidden="true" />
        <div className={styles.radarOrigin} aria-hidden="true">
          <span className={styles.radarOriginDot} />
          <span className={styles.radarOriginLabel}>AGOR</span>
        </div>
        {rosterMembers.map((member, index) => {
          const isDimmed = hoveredMember !== null && hoveredMember !== index;
          const blipClass = [
            styles.radarBlip,
            hoveredMember === index ? styles.radarBlipActive : '',
            isDimmed ? styles.radarBlipDimmed : '',
          ]
            .filter(Boolean)
            .join(' ');
          return member.story ? (
            <Link
              key={member.name}
              href={member.story}
              className={blipClass}
              style={radarPosition(member.r, member.a)}
              onMouseEnter={() => setHoveredMember(index)}
              onMouseLeave={() => setHoveredMember(null)}
              onFocus={() => setHoveredMember(index)}
              onBlur={() => setHoveredMember(null)}
              aria-label={`${member.name}: ${member.role}. Read the story`}
              onClick={() => trackEvent('roster_story_click', { member: member.name })}
            >
              <span className={styles.blipIcon}>
                <member.icon size={19} aria-hidden />
              </span>
              <span className={styles.blipName}>{member.name}</span>
            </Link>
          ) : (
            <button
              type="button"
              key={member.name}
              className={blipClass}
              style={radarPosition(member.r, member.a)}
              onMouseEnter={() => setHoveredMember(index)}
              onMouseLeave={() => setHoveredMember(null)}
              onFocus={() => setHoveredMember(index)}
              onBlur={() => setHoveredMember(null)}
              aria-label={`${member.name}: ${member.role}`}
            >
              <span className={styles.blipIcon}>
                <member.icon size={19} aria-hidden />
              </span>
              <span className={styles.blipName}>{member.name}</span>
            </button>
          );
        })}
        {/* Tooltips render as siblings (after all blips) so the active one
            stacks above every blip; visibility toggles via opacity. */}
        {rosterMembers.map((member, index) => {
          const tooltip = radarTooltip(member.r, member.a);
          const tooltipClass = [
            styles.radarTooltip,
            tooltip.below ? styles.radarTooltipBelow : '',
            hoveredMember === index ? styles.radarTooltipVisible : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={member.name}
              className={tooltipClass}
              style={tooltip.style}
              aria-hidden="true"
            >
              <p className={styles.tooltipName}>{member.name}</p>
              <p className={styles.tooltipRole}>{member.role}</p>
              <div className={styles.tooltipMeta}>
                <span className={styles.tooltipMem}>{member.meta}</span>
              </div>
              {member.story ? (
                <p className={styles.tooltipStory}>Click to read the story →</p>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* Phone-only: the floating tooltips clip against the scope edge on
          small screens, so the active member's card renders in a fixed
          panel below the radar instead (tapping a blip focuses it, which
          drives hoveredMember). Desktop keeps the tooltips. */}
      <div
        className={
          radarInView ? `${styles.radarDetail} ${styles.radarDetailVisible}` : styles.radarDetail
        }
        aria-live="polite"
      >
        {hoveredMember !== null ? (
          <>
            <p className={styles.tooltipName}>{rosterMembers[hoveredMember].name}</p>
            <p className={styles.tooltipRole}>{rosterMembers[hoveredMember].role}</p>
            <div className={styles.tooltipMeta}>
              <span className={styles.tooltipMem}>{rosterMembers[hoveredMember].meta}</span>
            </div>
            {rosterMembers[hoveredMember].story ? (
              <Link href={rosterMembers[hoveredMember].story ?? ''} className={styles.tooltipStory}>
                Read the story →
              </Link>
            ) : null}
          </>
        ) : (
          <p className={styles.radarDetailHint}>Tap a teammate to scan</p>
        )}
      </div>
    </section>
  );
}
