import { createRequire } from 'node:module';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

// Real published React -> real lazy client -> patched controller. Only hash /
// loader completion, CSSOM and MessageChannel are controlled here. This is
// jsdom integration, not evidence of browser port transfer or vendor rendering.
const require = createRequire(import.meta.url);
const reactRequire = createRequire(require.resolve('@codesandbox/sandpack-react'));
const clientPackage = reactRequire('@codesandbox/sandpack-client');
const realLoad: (...args: unknown[]) => Promise<Client> = clientPackage.loadSandpackClient;
type Client = API['sandpack']['clients'][string];
type WindowListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: unknown
) => void;
type API = ReturnType<typeof import('@codesandbox/sandpack-react').useSandpack>;
let pkg: typeof import('@codesandbox/sandpack-react');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Port {
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn();
}
class Channel {
  static instances: Channel[] = [];
  port1 = new Port();
  port2 = new Port();
  constructor() {
    Channel.instances.push(this);
  }
}
const relays = () => document.querySelectorAll('iframe[src*="/__csb_relay/"]');
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const hashes: ReturnType<typeof deferred<ArrayBuffer>>[] = [];
const loads: {
  start: ReturnType<typeof deferred<void>>;
  finish: ReturnType<typeof deferred<void>>;
  client?: Client;
}[] = [];
const apis = new Map<string, API>();
let autoHash = false;
let added: MockInstance<WindowListener>;
let removed: MockInstance<WindowListener>;

beforeAll(() => {
  // Stitches' grouping rule is unsupported by jsdom; no style assertions here.
  type Rule = { cssText: string; cssRules: Rule[]; insertRule: (r: string, i?: number) => number };
  const rule = (cssText: string): Rule => ({
    cssText,
    cssRules: [],
    insertRule(r, i = 0) {
      this.cssRules.splice(i, 0, rule(r));
      return i;
    },
  });
  const css = vi.spyOn(CSSStyleSheet.prototype, 'insertRule').mockImplementation(function (
    this: CSSStyleSheet,
    r,
    i = 0
  ) {
    (this.cssRules as unknown as Rule[]).splice(i, 0, rule(r));
    return i;
  });
  pkg = require('@codesandbox/sandpack-react');
  css.mockRestore();
});
beforeEach(() => {
  autoHash = false;
  hashes.length = 0;
  loads.length = 0;
  apis.clear();
  Channel.instances = [];
  vi.stubGlobal('MessageChannel', Channel);
  vi.stubGlobal('crypto', {
    subtle: {
      digest: () => {
        const hash = deferred<ArrayBuffer>();
        hashes.push(hash);
        if (autoHash) hash.resolve(new ArrayBuffer(32));
        return hash.promise;
      },
    },
  });
  vi.spyOn(clientPackage, 'loadSandpackClient').mockImplementation(async (...args: unknown[]) => {
    const load: (typeof loads)[number] = { start: deferred<void>(), finish: deferred<void>() };
    loads.push(load);
    await load.start.promise; // delayed lazy import / construction start
    load.client = await realLoad(...args);
    vi.spyOn(load.client, 'destroy');
    await load.finish.promise; // actual resources exist before owner receives result
    return load.client;
  });
  added = vi.spyOn(window, 'addEventListener');
  removed = vi.spyOn(window, 'removeEventListener');
});
afterEach(async () => {
  cleanup();
  await flush();
  // Fail before test-only emergency disposal: a failing negative control must
  // not contaminate the next case with deliberately orphaned real clients.
  try {
    expect(relays()).toHaveLength(0);
    for (const channel of Channel.instances) {
      expect(channel.port1.close).toHaveBeenCalledTimes(1);
      expect(channel.port2.close).toHaveBeenCalledTimes(1);
      expect(channel.port1.onmessage).toBeNull();
    }
    const listeners = added.mock.calls.filter(([type]) => type === 'message');
    for (const [, listener] of listeners) {
      expect(removed.mock.calls.some(([type, fn]) => type === 'message' && fn === listener)).toBe(
        true
      );
    }
  } finally {
    for (const load of loads) load.client?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

function Preview({ owner }: { owner: string }) {
  const api = pkg.useSandpack();
  apis.set(owner, api);
  const iframe = useRef<HTMLIFrameElement>(null);
  // Match the package hook: registration belongs to this mount, not render closures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: exercise upstream mount-only registration
  useEffect(() => {
    const element = iframe.current!;
    // jsdom retains a throwing location getter after iframe removal. Browsers
    // return null; model that only for detached previews, not owned relays.
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      'contentWindow'
    )!;
    Object.defineProperty(element, 'contentWindow', {
      get: () => (element.isConnected ? descriptor.get?.call(element) : null),
    });
    void api.sandpack.registerBundler(element, 'same-id');
    return () => api.sandpack.unregisterBundler('same-id');
  }, []);
  return (
    <div ref={api.sandpack.lazyAnchorRef}>
      <iframe ref={iframe} title={owner} />
    </div>
  );
}
function tree(owner = 'a', key = owner, initMode: 'immediate' | 'user-visible' = 'immediate') {
  return (
    <pkg.SandpackProvider
      key={key}
      template="static"
      files={{ '/index.html': '<h1>owned</h1>' }}
      options={{ initMode }}
    >
      <Preview owner={owner} />
    </pkg.SandpackProvider>
  );
}
async function finish(index: number) {
  loads[index].start.resolve();
  await flush();
  expect(loads[index].client).toBeDefined();
  loads[index].finish.resolve();
  await flush();
}

describe('Sandpack React asynchronous instance ownership', () => {
  it('unmount during hash does not start a loader', async () => {
    const view = render(tree());
    expect(hashes).toHaveLength(1);
    view.unmount();
    hashes[0].resolve(new ArrayBuffer(32));
    await flush();
    expect(loads).toHaveLength(0);
  });

  it('unmount during lazy loading destroys the late constructed real client', async () => {
    autoHash = true;
    const view = render(tree());
    await flush();
    expect(loads).toHaveLength(1);
    view.unmount();
    await finish(0);
    expect(loads[0].client!.destroy).toHaveBeenCalledTimes(1);
    expect(relays()).toHaveLength(0);
  });

  it('unmount while construction result is pending closes already-created resources', async () => {
    autoHash = true;
    const view = render(tree());
    await flush();
    loads[0].start.resolve();
    await flush();
    expect(relays()).toHaveLength(1);
    view.unmount();
    loads[0].finish.resolve();
    await flush();
    expect(loads[0].client!.destroy).toHaveBeenCalledTimes(1);
  });

  it('provider re-key leaves only the new live owner', async () => {
    autoHash = true;
    const view = render(tree('a', 'old'));
    await flush();
    view.rerender(tree('a', 'new'));
    await flush();
    await finish(1);
    const current = apis.get('a')!.sandpack.clients['same-id'];
    await finish(0);
    expect(apis.get('a')!.sandpack.clients['same-id']).toBe(current);
    expect(relays()).toHaveLength(1);
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
  });

  it('same-ID unregister/re-register ABA cannot overwrite or delete the replacement', async () => {
    autoHash = true;
    render(tree());
    await flush();
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="a"]')!;
    act(() => {
      apis.get('a')!.sandpack.unregisterBundler('same-id');
    });
    await act(async () => {
      await apis.get('a')!.sandpack.registerBundler(iframe, 'same-id');
    });
    let run!: Promise<void>;
    act(() => {
      run = apis.get('a')!.sandpack.runSandpack();
    });
    await flush();
    await finish(1);
    await run;
    await finish(0);
    expect(apis.get('a')!.sandpack.clients['same-id']).toBe(loads[1].client);
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
    expect(relays()).toHaveLength(1);
  });

  it('overlapping creations finishing second-first keep the latest attempt and listeners', async () => {
    autoHash = true;
    render(tree());
    await flush();
    const listener = vi.fn();
    const stop = apis.get('a')!.listen(listener, 'same-id');
    let run!: Promise<void>;
    act(() => {
      run = apis.get('a')!.sandpack.runSandpack();
    });
    await flush();
    await finish(1);
    await run;
    await finish(0);
    expect(apis.get('a')!.sandpack.clients['same-id']).toBe(loads[1].client);
    loads[1].client!.dispatch({ type: 'refresh' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
    stop();
    loads[1].client!.dispatch({ type: 'refresh' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(relays()).toHaveLength(1);
  });

  it('independent providers may share an ID without cross-owner teardown', async () => {
    autoHash = true;
    const view = render(
      <>
        {tree('a')}
        {tree('b')}
      </>
    );
    await flush();
    view.rerender(
      <>
        {null}
        {tree('b')}
      </>
    );
    await finish(1);
    await finish(0);
    expect(apis.get('b')!.sandpack.clients['same-id']).toBe(loads[1].client);
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
    expect(relays()).toHaveLength(1);
  });

  it('user-visible cancellation before construction preserves registration for resumption', async () => {
    autoHash = true;
    let notify!: IntersectionObserverCallback;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const visible = (isIntersecting: boolean) =>
      act(() => {
        notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
      });
    render(tree('a', 'a', 'user-visible'));
    expect(loads).toHaveLength(0);
    visible(true);
    await flush();
    visible(false);
    visible(true);
    await flush();
    expect(loads).toHaveLength(2);
    await finish(1);
    await finish(0);
    expect(relays()).toHaveLength(1);
    expect(apis.get('a')!.sandpack.clients['same-id']).toBe(loads[1].client);
    visible(false);
    expect(relays()).toHaveLength(0);
    visible(true);
    await flush();
    await finish(2);
    expect(relays()).toHaveLength(1);
  });

  it('late callbacks from a replaced published client cannot update provider state', async () => {
    autoHash = true;
    render(tree());
    await flush();
    loads[0].start.resolve();
    await flush();
    const listen = vi.spyOn(loads[0].client!, 'listen');
    loads[0].finish.resolve();
    await flush();
    const oldMessage = listen.mock.calls[0][0];
    let run!: Promise<void>;
    act(() => {
      run = apis.get('a')!.sandpack.runSandpack();
    });
    await flush();
    await finish(1);
    await run;
    act(() => {
      oldMessage({
        type: 'action',
        action: 'notification',
        notificationType: 'error',
        title: 'stale',
      });
    });
    expect(apis.get('a')!.sandpack.error).toBeNull();
    expect(loads[0].client!.destroy).toHaveBeenCalledTimes(1);
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
  });

  it('real SandpackPreview unmount during hashing cannot orphan a client', async () => {
    const view = render(
      <pkg.SandpackProvider template="static" options={{ initMode: 'immediate' }}>
        <pkg.SandpackPreview />
      </pkg.SandpackProvider>
    );
    expect(hashes).toHaveLength(1);
    view.unmount();
    hashes[0].resolve(new ArrayBuffer(32));
    await flush();
    expect(loads).toHaveLength(0);
  });

  it('canceled hash and import rejections are consumed, not unhandled', async () => {
    const view = render(tree());
    view.unmount();
    hashes[0].reject(new Error('canceled hash'));
    await flush();
    autoHash = true;
    const other = render(tree('b'));
    await flush();
    other.unmount();
    loads[0].start.reject(new Error('canceled import'));
    await flush();
    expect(loads[0].client).toBeUndefined();
  });

  it('an obsolete rejection cannot clear the newer client or report a stale error', async () => {
    autoHash = true;
    render(tree());
    await flush();
    let run!: Promise<void>;
    act(() => {
      run = apis.get('a')!.sandpack.runSandpack();
    });
    await flush();
    await finish(1);
    await run;
    loads[0].start.reject(new Error('obsolete import failed'));
    await flush();
    expect(apis.get('a')!.sandpack.clients['same-id']).toBe(loads[1].client);
    expect(apis.get('a')!.sandpack.error).toBeNull();
    expect(loads[1].client!.destroy).not.toHaveBeenCalled();
  });

  it('live loader rejection is reported and a new attempt can succeed', async () => {
    autoHash = true;
    render(tree());
    await flush();
    loads[0].start.reject(new Error('import failed'));
    await flush();
    expect(apis.get('a')!.sandpack.error?.message).toBe('import failed');
    let run!: Promise<void>;
    act(() => {
      run = apis.get('a')!.sandpack.runSandpack();
    });
    await flush();
    await finish(1);
    await run;
    expect(apis.get('a')!.sandpack.status).toBe('running');
    expect(apis.get('a')!.sandpack.error).toBeNull();
  });
});
