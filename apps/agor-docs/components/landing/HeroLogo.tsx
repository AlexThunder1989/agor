'use client';

import { useEffect, useState } from 'react';
import styles from './HeroLogo.module.css';

/* Geometry and motion from the app's loading spinner
   (apps/agor-ui/src/components/AgorLogoSpinner): 734×734 viewBox, 29px
   strokes, dots r=40 on a 297 orbit, inner ring r=189, centered at 367,367. */
const A_PATH =
  'M188,607 C188,607 306.427,380.615 351.693,294.083 C355.033,287.698 361.66,283.713 368.865,283.756 C376.071,283.799 382.649,287.862 385.914,294.286 C420.058,361.482 494,507 494,507';
const CROSSBAR_PATH =
  'M293.84,404.67 C307.45,431.55 335.34,450 367.5,450 C400,450 428.13,431.17 441.58,403.83';
const TAIL_PATHS = ['M367,70 A297,297 0 0,0 188,607', 'M367,664 A297,297 0 0,0 664,367'];
const DOTS = [
  { cx: 367, cy: 70 },
  { cx: 367, cy: 664 },
  { cx: 188, cy: 607 },
  { cx: 664, cy: 367 },
];

/** How long the logo spins (on load, and each time it's clicked). */
const SPIN_MS = 2600;

/**
 * The home hero's Agor mark: it spins like the app's loading spinner when the
 * page loads (the cursor troupe emerges from behind it), then settles into
 * the static logo. Clicking it spins it again; the troupe listens for the same
 * click to start its show over.
 */
export function HeroLogo({ className }: { className?: string }) {
  const [spinning, setSpinning] = useState(true);

  useEffect(() => {
    if (!spinning) return;
    const timer = setTimeout(() => setSpinning(false), SPIN_MS);
    return () => clearTimeout(timer);
  }, [spinning]);

  return (
    <button
      type="button"
      className={`${styles.logo}${spinning ? ` ${styles.spinning}` : ''}${className ? ` ${className}` : ''}`}
      onClick={() => setSpinning(true)}
      aria-label="Agor"
      title="Agor"
    >
      <svg
        viewBox="0 0 734 734"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth={29}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={CROSSBAR_PATH} />
        <path d={A_PATH} />
        <circle className={styles.ring} cx={367} cy={367} r={189} pathLength={100} />
        <g className={styles.orbit}>
          {TAIL_PATHS.map((d, index) => (
            <path
              key={d}
              className={index === 1 ? `${styles.tail} ${styles.tailAlt}` : styles.tail}
              d={d}
              pathLength={100}
            />
          ))}
          {DOTS.map(({ cx, cy }) => (
            <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={40} fill="currentColor" stroke="none" />
          ))}
        </g>
      </svg>
    </button>
  );
}
