// Marketing landing pages (hub-and-spoke off the homepage; see
// components/landing/pages.ts): full-bleed, hidden from the sidebar.
const landingPageMeta = {
  type: 'page' as const,
  display: 'hidden' as const,
  theme: {
    layout: 'full' as const,
    // The page renders its own footer (LandingShell); the docs footer would stack under it.
    footer: false,
  },
};

export default {
  index: {
    title: 'Home',
    type: 'page',
    display: 'hidden', // Hide from sidebar
    theme: {
      layout: 'full', // Full page layout without sidebars/navbar
    },
  },
  // Agor Cloud marketing landing page. Reached via the navbar "Agor Cloud"
  // link (see NavbarCloudCTA); hidden from the sidebar and rendered full-bleed
  // like the homepage via `theme.layout: 'full'`. The request-invite form
  // stays behind the on-page CTAs.
  cloud: {
    title: 'Agor Cloud',
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full',
      // AgorCloudLanding renders its own footer.
      footer: false,
    },
  },
  // Contact / "Talk to us" landing page. A standalone destination that renders
  // the same HubSpot scheduler as "Book a demo" inline; hidden from the sidebar
  // and rendered full-bleed like the homepage via `theme.layout: 'full'`.
  contact: {
    title: 'Contact',
    type: 'page',
    display: 'hidden',
    theme: {
      layout: 'full',
    },
  },
  multiplayer: landingPageMeta,
  board: landingPageMeta,
  teammates: landingPageMeta,
  'command-center': landingPageMeta,
  governance: landingPageMeta,
  // Navbar links are separate from the content folders so Docs and Blog can
  // also remain in the shared root sidebar on every content surface. The
  // Product menu mirrors components/landing/pages.ts.
  'product-navbar': {
    title: 'Product',
    type: 'menu',
    items: {
      multiplayer: { title: 'Multiplayer AI', href: '/multiplayer' },
      board: { title: 'Live board', href: '/board' },
      teammates: { title: 'AI teammates', href: '/teammates' },
      'command-center': { title: 'Command center', href: '/command-center' },
      governance: { title: 'Governance', href: '/governance' },
      security: { title: 'Security', href: '/security' },
      // Also the only phone-width route to /cloud: the navbar's Agor Cloud
      // link is hidden below 768px.
      cloud: { title: 'Agor Cloud', href: '/cloud' },
    },
  },
  'docs-navbar': { title: 'Docs', type: 'page', href: '/guide' },
  'blog-navbar': { title: 'Blog', type: 'page', href: '/blog' },
  guide: 'Docs',
  blog: 'Blog',
  'api-reference': 'API Reference',
  security: 'Security',
  faq: 'FAQ',
};
