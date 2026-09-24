'use client';

import { useState } from 'react';
import { CloudCtaLink } from './CloudCtaLink';
import styles from './CloudInviteCTA.module.css';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

interface CloudInviteCTAProps {
  /** Attribution slug for this spot (utm_content on the console link). */
  placement: string;
  demoLabel?: string;
}

export function CloudInviteCTA({ placement, demoLabel = 'Book a Demo' }: CloudInviteCTAProps) {
  // The scheduler opens in an on-site modal instead of linking out to the
  // (Preset-branded) meetings.hubspot.com page.
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  return (
    <div className={styles.wrapper}>
      <CloudCtaLink placement={placement} className={styles.primary} suffix=" →" />
      <button
        type="button"
        className={styles.secondary}
        style={{ cursor: 'pointer', font: 'inherit' }}
        onClick={() => setIsDemoOpen(true)}
      >
        {demoLabel} →
      </button>
      <HubSpotMeetingModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />
    </div>
  );
}
