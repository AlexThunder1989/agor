'use client';

import { useEffect, useState } from 'react';
import styles from './FontTrial.module.css';

/**
 * TEMPORARY: a corner switcher for comparing typefaces while we pick one.
 * Swaps the --font-display / --font-body variables (see app/styles.css), so
 * every surface that already uses the marketing stacks follows along. Shown in
 * dev, or on any build after visiting with `?fonts` once. Remove, along with
 * the trial fonts in app/layout.tsx, once a font is chosen.
 */
const OPTIONS = [
  { id: 'today', label: 'Today', title: 'Space Grotesk + Hanken Grotesk' },
  { id: 'dmsans', label: 'DM Sans', title: 'DM Sans' },
  { id: 'aspekta', label: 'Aspekta', title: 'Aspekta' },
] as const;

type TrialId = (typeof OPTIONS)[number]['id'];

const CHOICE_KEY = 'agor-font-trial';
const ENABLED_KEY = 'agor-font-trial-enabled';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the switch still works for this page.
  }
}

function apply(id: TrialId) {
  if (id === 'today') {
    delete document.documentElement.dataset.fontTrial;
  } else {
    document.documentElement.dataset.fontTrial = id;
  }
}

export function FontTrial() {
  const [visible, setVisible] = useState(false);
  const [choice, setChoice] = useState<TrialId>('today');

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('fonts')) write(ENABLED_KEY, '1');
    if (process.env.NODE_ENV !== 'development' && read(ENABLED_KEY) !== '1') return;
    const saved = read(CHOICE_KEY);
    const initial = OPTIONS.find((o) => o.id === saved)?.id ?? 'today';
    setChoice(initial);
    apply(initial);
    setVisible(true);
  }, []);

  if (!visible) return null;

  const pick = (id: TrialId) => {
    setChoice(id);
    apply(id);
    write(CHOICE_KEY, id);
  };

  return (
    <fieldset className={styles.trial}>
      <legend className={styles.legend}>Font</legend>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          aria-pressed={choice === option.id}
          className={choice === option.id ? `${styles.option} ${styles.active}` : styles.option}
          onClick={() => pick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
