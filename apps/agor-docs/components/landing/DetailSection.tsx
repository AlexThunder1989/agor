'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { HighlightedText } from '../heroCopy';
import styles from '../LandingPage.module.css';
import type { DetailMedia, LandingDetail } from './details/types';

// Plays only while on screen, so a page of loops never decodes them all at once.
function InViewVideo({ media }: { media: Extract<DetailMedia, { type: 'video' }> }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.35 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      className={styles.detailMedia}
      muted
      loop
      playsInline
      preload="none"
      poster={media.poster}
      aria-label={media.alt}
    >
      {media.srcSmall ? (
        <source src={media.srcSmall} type="video/mp4" media="(max-width: 720px)" />
      ) : null}
      <source src={media.src} type="video/mp4" />
    </video>
  );
}

export function DetailSection({ detail }: { detail: LandingDetail }) {
  const { media } = detail;
  return (
    <section
      id={detail.id}
      className={media ? styles.detailSection : `${styles.detailSection} ${styles.detailTextOnly}`}
      data-reveal
    >
      <div className={styles.detailCopy}>
        {detail.eyebrow ? <span className={styles.eyebrow}>{detail.eyebrow}</span> : null}
        <h2 className={styles.detailTitle}>
          <HighlightedText text={detail.title} />
        </h2>
        {detail.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {detail.points?.length ? (
          <ul className={styles.detailPoints}>
            {detail.points.map((point) => (
              <li key={point.title}>
                <strong>{point.title}</strong>
                <span>{point.body}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {detail.links?.length ? (
          <p className={styles.detailLinks}>
            {detail.links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                {...(link.href.startsWith('http')
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
              >
                {link.label} <span aria-hidden="true">→</span>
              </Link>
            ))}
          </p>
        ) : null}
      </div>
      {media ? (
        <div className={styles.detailMediaFrame}>
          {media.type === 'video' ? (
            <InViewVideo media={media} />
          ) : (
            // biome-ignore lint/performance/noImgElement: Static product screenshot
            <img className={styles.detailMedia} src={media.src} alt={media.alt} loading="lazy" />
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Jump links under a landing hero; one per detail block. */
export function DetailNav({ details }: { details: LandingDetail[] }) {
  return (
    <nav className={styles.detailNav} aria-label="On this page">
      {details.map((detail) => (
        <a key={detail.id} href={`#${detail.id}`} className={styles.heroHubLink}>
          {detail.navLabel}
        </a>
      ))}
    </nav>
  );
}
