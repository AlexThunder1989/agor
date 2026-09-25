'use client';

import { Boxes, DatabaseZap, EyeOff, type LucideIcon, Repeat, Unlink, UserX } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import styles from '../LandingPage.module.css';
import { LandingLink } from './LandingLink';
import type { LandingPageId } from './pages';

// "The problem" cards — the diagnosis before the pitch. Amber accents (see
// .problemCard in the CSS module) mark these as the warning register; the
// mint solution palette arrives at the pivot line below the grid.
// Each card links to the landing page that answers it.
const problemCards: Array<{
  icon: LucideIcon;
  title: string;
  page: LandingPageId;
  anchor: string;
  body: ReactNode;
}> = [
  {
    icon: UserX,
    title: 'Everyone’s figuring it out alone',
    page: 'multiplayer',
    anchor: 'learn-together',
    body: (
      <>
        Each person experiments behind <strong>their own screen</strong>. Good techniques stay
        private, and the team repeats the same mistakes.
      </>
    ),
  },
  {
    icon: Boxes,
    title: 'Too many agents to track',
    page: 'command-center',
    anchor: 'zones-and-prompts',
    body: (
      <>
        More agents and conversations mean more coordination. Which one is <strong>blocked</strong>?
        Which one <strong>needs you</strong>?
      </>
    ),
  },
  {
    icon: Repeat,
    title: 'Starting over every time',
    page: 'teammates',
    anchor: 'memory',
    body: (
      <>
        Good context gets buried in old conversations, so every recurring task needs the{' '}
        <strong>same explanation</strong> again.
      </>
    ),
  },
  {
    icon: Unlink,
    title: 'Workflows only one person can run',
    page: 'teammates',
    anchor: 'shared-ownership',
    body: (
      <>
        That useful PR reviewer lives in <strong>one person’s setup</strong>. Nobody else can
        improve it or take it over.
      </>
    ),
  },
  {
    icon: DatabaseZap,
    title: 'Context scattered everywhere',
    page: 'command-center',
    anchor: 'knowledge',
    body: (
      <>
        Knowledge is <strong>spread</strong> across repos, docs, and DMs, so agents answer without
        your team’s <strong>actual context</strong>.
      </>
    ),
  },
  {
    icon: EyeOff,
    title: 'New tools, same old habits',
    page: 'multiplayer',
    anchor: 'enablers',
    body: (
      <>
        Handing out AI accounts doesn’t create <strong>shared practices</strong>. Individual wins
        never become the way the team works.
      </>
    ),
  },
];

// Static scatter pose per problem card (SSR-safe literals — no randomness).
// --slot-y/--slot-rot/--slot-ml/--slot-z are the resting collision pose;
// --slot-rx/--slot-ry are a subtle 3D "tossed pile" tilt (rotateX/rotateY)
// that only appears in the settled state — cards travel flat and pick the
// tilt up with the impact jolt. --enter-x is how far off to the RIGHT each
// card starts its glide-in; cards FADE IN mid-journey (0→1 over the first
// 200ms) already moving at full speed. All six travel as one straight,
// vertically ALIGNED convoy at the same constant speed (0.75px/ms):
// enter-x = 450px lead travel + 60px per travel gap, so each card runs out
// of road exactly 80ms after the one ahead. The lead brakes at the wall;
// everyone behind plows in at full speed, and each impact knocks the card
// ahead into its resting Y/rotation/3D tilt — see @keyframes
// problemCrash1–6 in the CSS module. --slot-delay only staggers the mobile
// fade-up fallback.
const problemScatterSlots = [
  {
    '--slot-y': '30px',
    '--slot-rot': '-2.4deg',
    '--slot-rx': '2.6deg',
    '--slot-ry': '-4.2deg',
    '--slot-ml': '0px',
    '--slot-z': 3,
    '--slot-delay': '0ms',
    '--enter-x': '450px',
  },
  {
    '--slot-y': '-40px',
    '--slot-rot': '3.1deg',
    '--slot-rx': '-3.4deg',
    '--slot-ry': '3.1deg',
    '--slot-ml': '-24px',
    '--slot-z': 4,
    '--slot-delay': '110ms',
    '--enter-x': '510px',
  },
  {
    '--slot-y': '70px',
    '--slot-rot': '-3deg',
    '--slot-rx': '3.8deg',
    '--slot-ry': '4.6deg',
    '--slot-ml': '-30px',
    '--slot-z': 6,
    '--slot-delay': '220ms',
    '--enter-x': '570px',
  },
  {
    '--slot-y': '-50px',
    '--slot-rot': '2.3deg',
    '--slot-rx': '-2.2deg',
    '--slot-ry': '-5deg',
    '--slot-ml': '-38px',
    '--slot-z': 5,
    '--slot-delay': '330ms',
    '--enter-x': '630px',
  },
  {
    '--slot-y': '20px',
    '--slot-rot': '-1.7deg',
    '--slot-rx': '3.2deg',
    '--slot-ry': '2.4deg',
    '--slot-ml': '-20px',
    '--slot-z': 2,
    '--slot-delay': '440ms',
    '--enter-x': '690px',
  },
  {
    '--slot-y': '-10px',
    '--slot-rot': '2.8deg',
    '--slot-rx': '-3.9deg',
    '--slot-ry': '-3.3deg',
    '--slot-ml': '-28px',
    '--slot-z': 1,
    '--slot-delay': '550ms',
    '--enter-x': '750px',
  },
] as unknown as CSSProperties[];

export function ProblemSection() {
  return (
    <section className={styles.problemSection} data-reveal>
      <h2 className={styles.liveStatement}>
        Don&rsquo;t let AI <span className={styles.headingAccentWarm}>silo</span> your{' '}
        <span className={styles.headingStrong}>team</span>
      </h2>
      <p className={styles.liveSub}>
        <span className={styles.headingDim}>
          We’re getting better at AI on our own, but not better together.
        </span>
      </p>
      {/* Sits ABOVE the pileup so the question reads as pointing at the
          cards below it, not at the next section. */}
      <p className={styles.problemPivot}>
        Sound <span className={styles.headingAccentWarm}>familiar</span>?
        <span aria-hidden="true"> ↓</span>
      </p>
      {/* Collision composition: slots carry the static scatter pose (rotate/
          translate/negative margins/z-index via CSS vars) plus the crash
          entrance animation, keyed off .problemSection.isVisible — the inner
          .problemCard keeps its own hover behavior. Cards deliberately lack
          data-reveal so the shared reveal transform can't fight the crash
          keyframes. */}
      <div className={styles.problemScatter}>
        {problemCards.map((card, index) => (
          <div className={styles.problemSlot} key={card.title} style={problemScatterSlots[index]}>
            <article className={`${styles.numberedCard} ${styles.problemCard}`}>
              <span className={styles.problemIcon}>
                <card.icon size={17} aria-hidden />
              </span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              <LandingLink
                page={card.page}
                anchor={card.anchor}
                placement="home-problem"
                className={styles.problemLink}
              >
                See how Agor helps <span aria-hidden="true">→</span>
              </LandingLink>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
