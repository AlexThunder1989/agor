const CONSOLE_ORIGIN = 'https://console.cloud.agor.live';

export const TEAM_SIGNUP_STATUS_URL = `${CONSOLE_ORIGIN}/api/team-signup/status`;

export type TeamSignupStatus = 'available' | 'invite_required' | 'capacity_unavailable';

export interface CloudCta {
  label: string;
  href: string;
}

const CTA_BY_STATUS: Record<TeamSignupStatus, CloudCta> = {
  available: { label: 'Get Agor Cloud', href: `${CONSOLE_ORIGIN}/` },
  invite_required: {
    label: 'Join the Agor Cloud waitlist',
    href: `${CONSOLE_ORIGIN}/request-invite`,
  },
  // The console root serves both sign-in and the waitlist, so it also covers
  // the unknown-status case (the no-JS href; CloudCtaLink opens the HubSpot
  // modal on click instead).
  capacity_unavailable: { label: 'Sign up for Agor Cloud', href: `${CONSOLE_ORIGIN}/` },
};

const FALLBACK_CLOUD_CTA = CTA_BY_STATUS.capacity_unavailable;

const CTA_UTM_BASE = 'utm_source=agor.live&utm_medium=referral&utm_campaign=agor-cloud-cta';

export function isTeamSignupStatus(value: unknown): value is TeamSignupStatus {
  return typeof value === 'string' && Object.hasOwn(CTA_BY_STATUS, value);
}

/** `placement` becomes utm_content, so each CTA spot is attributable in the console. */
export function cloudCtaFor(status: TeamSignupStatus | null, placement: string): CloudCta {
  const cta = status ? CTA_BY_STATUS[status] : FALLBACK_CLOUD_CTA;
  return {
    label: cta.label,
    href: `${cta.href}?${CTA_UTM_BASE}&utm_content=${encodeURIComponent(placement)}`,
  };
}
