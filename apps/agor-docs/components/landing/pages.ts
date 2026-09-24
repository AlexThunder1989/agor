import type { HeroCopy } from '../heroCopy';

export type LandingPageId = 'multiplayer' | 'board' | 'teammates' | 'command-center' | 'governance';

export interface LandingPageEntry {
  id: LandingPageId;
  href: `/${string}`;
  /** Home-hero hub button and "learn more" link text. */
  navLabel: string;
  badge: string;
  hero: HeroCopy;
  docs: Array<{ label: string; href: string }>;
}

// Order follows the positioning hierarchy: Multiplayer AI, the board,
// teammates, then the builder and trust stories. It is also the order of the
// home hero's hub buttons.
export const LANDING_PAGES: LandingPageEntry[] = [
  {
    id: 'multiplayer',
    href: '/multiplayer',
    navLabel: 'Multiplayer AI',
    badge: 'Multiplayer AI',
    hero: {
      headline: 'Work together\n[again]',
      subheadline: 'Bring your {team} and {agents} together, and build on what works.',
    },
    docs: [
      { label: 'Multiplayer & social features', href: '/guide/multiplayer-social' },
      { label: 'Branches & shared environments', href: '/guide/branches' },
      { label: 'Supported agents', href: '/guide/sdk-comparison' },
    ],
  },
  {
    id: 'board',
    href: '/board',
    navLabel: 'Live board',
    badge: 'Live spatial board',
    hero: {
      headline: 'See the work and\n[shape it together]',
      subheadline: 'Every agent session, branch, and zone on one live {board}.',
    },
    docs: [
      { label: 'Boards & zones', href: '/guide/boards' },
      { label: 'Sessions & trees', href: '/guide/sessions' },
      { label: 'Message gateway', href: '/guide/message-gateway' },
    ],
  },
  {
    id: 'teammates',
    href: '/teammates',
    navLabel: 'AI teammates',
    badge: 'AI teammates',
    hero: {
      headline: 'Raise [AI teammates]\nyour team can teach',
      subheadline: 'Give them {memory}, teach them {skills}, and bring them where your team works.',
    },
    docs: [
      { label: 'Teammates', href: '/guide/teammates' },
      { label: 'Knowledge', href: '/guide/knowledge' },
      { label: 'Scheduler', href: '/guide/scheduler' },
      { label: 'Message gateway', href: '/guide/message-gateway' },
    ],
  },
  {
    id: 'command-center',
    href: '/command-center',
    navLabel: 'Command center',
    badge: 'For builders',
    hero: {
      headline: 'Stay sane with\n[a lot of agents]',
      subheadline: 'A {command center} for agent work, with the context and tools close by.',
    },
    docs: [
      { label: 'Feature map', href: '/guide/features-overview' },
      { label: 'Artifacts', href: '/guide/artifacts' },
      { label: 'Environments', href: '/guide/environment-configuration' },
      { label: 'Agor MCP server', href: '/guide/internal-mcp' },
    ],
  },
  {
    id: 'governance',
    href: '/governance',
    navLabel: 'Governance',
    badge: 'Governance & observability',
    hero: {
      headline: 'Know what’s [running]',
      subheadline: 'And what it costs, and {who can do what}.',
    },
    docs: [
      { label: 'Security', href: '/security' },
      { label: 'RBAC & isolation', href: '/guide/multiplayer-unix-isolation' },
      { label: 'Agor Cloud', href: '/cloud' },
    ],
  },
];

export function landingPage(id: LandingPageId): LandingPageEntry {
  const page = LANDING_PAGES.find((entry) => entry.id === id);
  if (!page) throw new Error(`Unknown landing page: ${id}`);
  return page;
}
