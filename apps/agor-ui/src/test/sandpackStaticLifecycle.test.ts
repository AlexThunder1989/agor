import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve the exact transitive client that Sandpack React loads, including its
// lazy static chunk. The published ./clients/static export has no JS files.
const reactRequire = createRequire(import.meta.resolve('@codesandbox/sandpack-react'));
const entry = reactRequire.resolve('@codesandbox/sandpack-client');

class Port {
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn();
  receive(type: string, data = {}) {
    this.onmessage?.({ data: { $channel: '$CSB_RELAY', $type: type, ...data } });
  }
}
class Channel {
  static instances: Channel[] = [];
  port1 = new Port();
  port2 = new Port();
  constructor() {
    Channel.instances.push(this);
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const relays = () => [
  ...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/__csb_relay/"]'),
];

beforeEach(() => {
  Channel.instances = [];
  vi.stubGlobal('MessageChannel', Channel);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// CJS runtime here; the browser acceptance run exercises Vite's ESM entry.
describe('static Sandpack dependency lifecycle', () => {
  async function mount() {
    const module = reactRequire(entry);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const client = await module.loadSandpackClient(iframe, {
      template: 'static',
      files: { '/index.html': { code: '<!doctype html><h1>Benign lifecycle fixture</h1>' } },
    });
    return { client, iframe, channel: Channel.instances.at(-1)!, relay: relays().at(-1)! };
  }

  it('releases three initialized previews without touching a concurrent owner', async () => {
    const other = await mount();
    other.channel.port1.receive('preview/ready');
    await settle();
    for (let cycle = 0; cycle < 3; cycle++) {
      const previews = [await mount(), await mount(), await mount()];
      for (const preview of previews) preview.channel.port1.receive('preview/ready');
      await settle();
      for (const { client, iframe } of previews) {
        expect(iframe.src).toMatch(
          /^https:\/\/.*preview\.sandpack-static-server\.codesandbox\.io\/$/
        );
        client.destroy();
        client.destroy();
        iframe.remove();
      }
      expect(relays()).toEqual([other.relay]);
      for (const { channel, relay } of previews) {
        expect(channel.port1.close).toHaveBeenCalledTimes(1);
        expect(channel.port2.close).toHaveBeenCalledTimes(1);
        expect(channel.port1.onmessage).toBeNull();
        expect(relay.onload).toBeNull();
      }
      other.channel.port1.receive('preview/request', { id: `cycle-${cycle}`, url: '/' });
      await settle();
      expect(other.channel.port1.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 200 })
      );
      expect(other.channel.port1.close).not.toHaveBeenCalled();
    }
    other.client.destroy();
    expect(relays()).toHaveLength(0);
  });

  it('cancels before ready and ignores late initialization, updates, and double destroy', async () => {
    const { client, iframe, channel, relay } = await mount();
    const lateReady = channel.port1.onmessage;
    const listener = vi.fn();
    client.listen(listener);
    client.destroy();
    client.destroy();
    lateReady?.({ data: { $channel: '$CSB_RELAY', $type: 'preview/ready' } });
    client.updateSandbox();
    client.dispatch({ type: 'refresh' });
    await settle();
    expect(iframe.hasAttribute('src')).toBe(false);
    expect(relay.isConnected).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(Channel.instances).toHaveLength(1);
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
  });

  it('does not navigate or emit when destroyed between ready and the compile continuation', async () => {
    const { client, iframe, channel } = await mount();
    const listener = vi.fn();
    client.listen(listener);
    channel.port1.receive('preview/ready');
    client.destroy();
    await settle();
    expect(iframe.hasAttribute('src')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(relays()).toHaveLength(0);
  });

  it('keeps updates, refresh, source filtering, and the one-time port handshake working', async () => {
    const { client, iframe, channel, relay } = await mount();
    const relayPost = vi.spyOn(relay.contentWindow!, 'postMessage');
    relay.dispatchEvent(new Event('load'));
    relay.dispatchEvent(new Event('load'));
    expect(relayPost).toHaveBeenCalledExactlyOnceWith(
      { $channel: '$CSB_RELAY', $type: 'preview/init' },
      '*',
      [channel.port2]
    );
    channel.port1.receive('preview/ready');
    await settle();
    const src = iframe.src;
    client.updateSandbox({
      template: 'static',
      files: { '/index.html': { code: '<h1>Updated</h1>' } },
    });
    await settle();
    expect(iframe.src).toBe(src);
    expect(Channel.instances).toHaveLength(1);
    channel.port1.receive('preview/request', { id: 'updated', url: '/' });
    await settle();
    expect(channel.port1.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 200, body: expect.stringContaining('<h1>Updated</h1>') })
    );
    const listener = vi.fn();
    client.listen(listener);
    client.eventListener({ source: window, data: { codesandbox: true, type: 'foreign' } });
    expect(listener).not.toHaveBeenCalled();
    const previewPost = vi.spyOn(iframe.contentWindow!, 'postMessage');
    client.dispatch({ type: 'refresh' });
    expect(previewPost).toHaveBeenCalledWith({ type: 'refresh' }, '*');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    client.destroy();
    expect(removeListener).toHaveBeenCalledWith('message', client.eventListener);
    const lateListener = vi.fn();
    client.listen(lateListener)();
    client.dispatch({ type: 'refresh' });
    expect(lateListener).not.toHaveBeenCalled();
    expect(previewPost).toHaveBeenCalledTimes(1);
  });

  it('removes only its actual relay, even when an unrelated iframe has an identical URL', async () => {
    const { client, channel, relay } = await mount();
    channel.port1.receive('preview/ready');
    await settle();
    const unrelated = relay.cloneNode() as HTMLIFrameElement;
    document.body.appendChild(unrelated);
    client.destroy();
    expect(relay.isConnected).toBe(false);
    expect(unrelated.isConnected).toBe(true);
    expect(relays()).toEqual([unrelated]);
  });
});

describe('static preview controller cancellation', () => {
  const { PreviewController } = createRequire(entry)('static-browser-server');

  it('can be destroyed before initialization without allocating any resources', async () => {
    const controller = new PreviewController({
      baseUrl: 'https://preview.example.test',
      getFileContent: vi.fn(),
    });
    controller.destroy();
    controller.destroy();
    await expect(controller.initPreview()).rejects.toThrow('destroyed');
    expect(Channel.instances).toHaveLength(0);
    expect(relays()).toHaveLength(0);
  });

  it('settles a cancelled handshake and ignores queued onload and ready callbacks', async () => {
    const controller = new PreviewController({
      baseUrl: 'https://preview.example.test',
      getFileContent: vi.fn(),
    });
    const initialized = controller.initPreview();
    const rejected = expect(initialized).rejects.toThrow('destroyed');
    const relay = relays()[0];
    const lateLoad = relay.onload!;
    const port = Channel.instances[0].port1;
    const lateReady = port.onmessage!;
    const post = vi.spyOn(relay.contentWindow!, 'postMessage');
    controller.destroy();
    lateLoad.call(relay, new Event('load'));
    lateReady({ data: { $channel: '$CSB_RELAY', $type: 'preview/ready' } });
    await rejected;
    expect(post).not.toHaveBeenCalled();
    expect(relays()).toHaveLength(0);
  });

  it('cancels a worker request already waiting for initialization without an unhandled rejection', async () => {
    const read = vi.fn();
    const controller = new PreviewController({
      baseUrl: 'https://preview.example.test',
      getFileContent: read,
    });
    const initialized = controller.initPreview();
    const cancelled = expect(initialized).rejects.toThrow('destroyed');
    const port = Channel.instances[0].port1;
    port.receive('preview/request', { id: 'before-ready', url: '/' });
    controller.destroy();
    await cancelled;
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(relays()).toHaveLength(0);
  });

  for (const reject of [false, true]) {
    it(`does not respond after disposal during an async file lookup (${reject ? 'reject' : 'resolve'})`, async () => {
      let complete!: () => void;
      const file = new Promise<string>((resolve, rejectFile) => {
        complete = () =>
          reject ? rejectFile(new Error('late file error')) : resolve('late content');
      });
      const read = vi.fn(() => file);
      const controller = new PreviewController({
        baseUrl: 'https://preview.example.test',
        getFileContent: read,
      });
      const initialized = controller.initPreview();
      const port = Channel.instances[0].port1;
      port.receive('preview/ready');
      await initialized;
      port.receive('preview/request', { id: 'pending', url: '/pending.html' });
      await settle();
      expect(read).toHaveBeenCalledTimes(1);
      controller.destroy();
      complete();
      await settle();
      expect(port.postMessage).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      expect(port.onmessage).toBeNull();
      expect(port.close).toHaveBeenCalledTimes(1);
    });
  }
});
