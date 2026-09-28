const CONSOLE_ORIGIN = 'https://console.cloud.agor.live';

export const TEAM_SIGNUP_STATUS_URL = `${CONSOLE_ORIGIN}/api/team-signup/status`;

export type TeamSignupStatus = 'available' | 'invite_required' | 'capacity_unavailable';

/** Which button the visitor was shown; reported to analytics alongside the status. */
export type CloudCtaVariant = 'console' | 'waitlist' | 'capacity' | 'hubspot_modal';

export interface CloudCta {
  label: string;
  href: string;
  variant: CloudCtaVariant;
}

const CTA_BY_STATUS: Record<TeamSignupStatus, CloudCta> = {
  available: { label: 'Get Agor Cloud', href: `${CONSOLE_ORIGIN}/`, variant: 'console' },
  invite_required: {
    label: 'Join the Agor Cloud waitlist',
    href: `${CONSOLE_ORIGIN}/request-invite`,
    variant: 'waitlist',
  },
  capacity_unavailable: {
    label: 'Sign up for Agor Cloud',
    href: `${CONSOLE_ORIGIN}/`,
    variant: 'capacity',
  },
};

// Unknown status (loading, failed, unexpected body): CloudCtaLink opens the
// HubSpot modal on click. The console root is the no-JS href since it serves
// both sign-in and the waitlist.
const UNKNOWN_STATUS_CTA: CloudCta = {
  label: 'Sign up for Agor Cloud',
  href: `${CONSOLE_ORIGIN}/`,
  variant: 'hubspot_modal',
};

/** Short labels for tight spots such as the navbar island. */
export const COMPACT_CTA_LABELS: Record<CloudCtaVariant, string> = {
  console: 'Try Cloud',
  waitlist: 'Join waitlist',
  capacity: 'Sign up',
  hubspot_modal: 'Try Cloud',
};

const CTA_UTM_BASE = 'utm_source=agor.live&utm_medium=referral&utm_campaign=agor-cloud-cta';

export function isTeamSignupStatus(value: unknown): value is TeamSignupStatus {
  return typeof value === 'string' && Object.hasOwn(CTA_BY_STATUS, value);
}

/** `placement` becomes utm_content, so each CTA spot is attributable in the console. */
export function cloudCtaFor(status: TeamSignupStatus | null, placement: string): CloudCta {
  const cta = status ? CTA_BY_STATUS[status] : UNKNOWN_STATUS_CTA;
  return {
    ...cta,
    href: `${cta.href}?${CTA_UTM_BASE}&utm_content=${encodeURIComponent(placement)}`,
  };
}
