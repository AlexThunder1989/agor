'use client';

import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type CloudCta,
  cloudCtaFor,
  isTeamSignupStatus,
  TEAM_SIGNUP_STATUS_URL,
  type TeamSignupStatus,
} from '../lib/cloudCta';
import { HubSpotFormModal } from './HubSpotFormModal';

const STATUS_TIMEOUT_MS = 4000;

// One request per page load, shared by every CTA on the page.
let statusRequest: Promise<TeamSignupStatus | null> | undefined;

function fetchTeamSignupStatus(): Promise<TeamSignupStatus | null> {
  statusRequest ??= fetch(TEAM_SIGNUP_STATUS_URL, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => (isTeamSignupStatus(body?.status) ? body.status : null))
    .catch(() => null);
  return statusRequest;
}

/** Static export renders the fallback CTA; the live gate status swaps it in after hydration. */
export function useCloudCta(placement: string): CloudCta & { status: TeamSignupStatus | null } {
  const [status, setStatus] = useState<TeamSignupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTeamSignupStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { ...cloudCtaFor(status, placement), status };
}

interface CloudCtaLinkProps {
  placement: string;
  className?: string;
  /** Rendered after the label, e.g. an arrow. */
  suffix?: ReactNode;
}

/**
 * Links to the console when the gate status is known. While the status is
 * unknown (still loading, request failed, unexpected body) a click opens the
 * HubSpot sign-up modal instead; the href stays as the no-JS fallback.
 */
export function CloudCtaLink({ placement, className, suffix }: CloudCtaLinkProps) {
  const { label, href, status } = useCloudCta(placement);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const w = window as Window & { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({
      event: 'agor_cloud_cta_click',
      source_page: placement,
      signup_status: status ?? 'unknown',
    });
    if (status === null) {
      event.preventDefault();
      setIsFormOpen(true);
    }
  };

  return (
    <>
      <a href={href} className={className} onClick={onClick}>
        {label}
        {suffix}
      </a>
      {/* Portaled: CTAs sit inside transformed reveal sections, which would
          otherwise trap the modal's position: fixed. */}
      {isFormOpen &&
        createPortal(
          <HubSpotFormModal
            isOpen
            onClose={() => setIsFormOpen(false)}
            title="Sign up for Agor Cloud"
            sourceCta={placement}
          />,
          document.body
        )}
    </>
  );
}
