import type { TriggerRef } from '@rc-component/trigger/es';
import TriggerEsm from '@rc-component/trigger/es';
import TriggerCjs from '@rc-component/trigger/lib';
import { composeRef } from '@rc-component/util';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Dropdown } from 'antd';
import {
  Component,
  createRef,
  forwardRef,
  Profiler,
  type ReactNode,
  type Ref,
  StrictMode,
  Suspense,
  startTransition,
  useRef,
  useState,
} from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const Child = forwardRef<HTMLButtonElement, { visible: boolean; name?: string }>(
  ({ visible, name = 'Target' }, ref) =>
    visible ? (
      <button type="button" ref={ref}>
        {name}
      </button>
    ) : null
);

// Exercise the actual installed entrypoints, not a test-only event/DOM workaround.
// Under NODE_ENV=test, util uses a passive layout-effect fallback. Production
// ordering and GC are validated separately, not inferred from these tests.
describe.each([
  ['ESM', TriggerEsm],
  ['CJS', TriggerCjs],
] as const)('tooltip target ownership (%s)', (_format, Trigger) => {
  afterEach(() => vi.useRealTimers());

  it('releases a removed target and supports StrictMode detach/reattach and ref replacement', () => {
    const ownerRef = createRef<TriggerRef>();
    const first = createRef<HTMLButtonElement>();
    const second = vi.fn<(node: HTMLButtonElement | null) => void>();
    const view = (visible: boolean, replaced = false) => (
      <StrictMode>
        <Trigger ref={ownerRef} popup={<div>Tip</div>} action={['focus']}>
          <Child visible={visible} ref={replaced ? second : first} />
        </Trigger>
      </StrictMode>
    );
    const { rerender, unmount } = render(view(true));
    expect(ownerRef.current?.nativeElement).toBe(screen.getByRole('button'));
    expect(first.current).toBe(screen.getByRole('button'));
    rerender(view(true, true));
    expect(first.current).toBeNull();
    expect(second).toHaveBeenLastCalledWith(screen.getByRole('button'));
    rerender(view(false, true));
    expect(second).toHaveBeenLastCalledWith(null);
    expect(ownerRef.current?.nativeElement).toBeNull();
    rerender(view(true, true));
    expect(ownerRef.current?.nativeElement).toBe(screen.getByRole('button'));
    unmount();
    expect(ownerRef.current).toBeNull();
    expect(second).toHaveBeenLastCalledWith(null);
    const remount = render(view(true));
    expect(ownerRef.current?.nativeElement).toBe(screen.getByRole('button'));
    remount.unmount();
  });

  it('notifies replacement child refs without extra Trigger commits for the same DOM node', () => {
    const calls = vi.fn();
    let commits = 0;
    let bump = () => {};
    function Parent() {
      const [, setVersion] = useState(0);
      bump = () => setVersion((value) => value + 1);
      const stable = useRef<HTMLButtonElement>(null);
      // rc-dropdown composes a new child ref on each parent render.
      return (
        <Profiler
          id="trigger"
          onRender={() => {
            commits += 1;
          }}
        >
          <Trigger popup={<div>Tip</div>}>
            <button type="button" ref={composeRef(stable, calls)}>
              Target
            </button>
          </Trigger>
        </Profiler>
      );
    }
    const { unmount } = render(<Parent />);
    for (let i = 0; i < 5; i += 1) {
      calls.mockClear();
      const before = commits;
      act(() => bump());
      // Correct external detach/attach is required; baseline silently keeps stale refs.
      expect(calls.mock.calls.map(([node]) => (node === null ? 'null' : 'node'))).toEqual([
        'null',
        'node',
      ]);
      expect(commits - before).toBe(1);
    }
    unmount();
  });

  it('keeps actual Dropdown parent updates to one commit while notifying its child ref', () => {
    const calls = vi.fn();
    let commits = 0;
    const view = (version: number) => (
      <Profiler
        id="dropdown"
        onRender={() => {
          commits += 1;
        }}
      >
        <Dropdown menu={{ items: [{ key: 'one', label: 'One' }] }}>
          <button type="button" ref={calls}>
            Dropdown {version}
          </button>
        </Dropdown>
      </Profiler>
    );
    const { rerender, unmount } = render(view(0));
    for (let i = 1; i <= 5; i += 1) {
      calls.mockClear();
      const before = commits;
      rerender(view(i));
      expect(calls.mock.calls.map(([node]) => (node === null ? 'null' : 'node'))).toEqual([
        'null',
        'node',
      ]);
      expect(commits - before).toBe(1);
    }
    unmount();
  });

  it('publishes nativeElement=null after descendant-only target removal', async () => {
    const owner = createRef<TriggerRef>();
    let remove = () => {};
    const Independent = forwardRef<HTMLButtonElement>((_props, ref) => {
      const [visible, setVisible] = useState(true);
      remove = () => setVisible(false);
      return visible ? (
        <button type="button" ref={ref}>
          Target
        </button>
      ) : null;
    });
    const { unmount } = render(
      <Trigger ref={owner} popup={<div>Tip</div>}>
        <Independent />
      </Trigger>
    );
    expect(owner.current?.nativeElement).toBe(screen.getByRole('button'));
    await act(async () => remove());
    expect(owner.current?.nativeElement).toBeNull();
    unmount();
  });

  it('preserves React 19 cleanup-return semantics on the forwarded owner ref', () => {
    const cleanup = vi.fn();
    const ref = vi.fn<(value: TriggerRef | null) => (() => void) | undefined>((value) =>
      value ? cleanup : undefined
    );
    const { unmount } = render(
      <Trigger ref={ref} popup={<div>Tip</div>}>
        <button type="button">Target</button>
      </Trigger>
    );
    const attachments = ref.mock.calls.length;
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(attachments);
    expect(ref.mock.calls.every(([value]) => value !== null)).toBe(true);
  });

  it.each(['attach', 'cleanup'] as const)('clears the target when child ref %s throws', (phase) => {
    const owner = createRef<TriggerRef>();
    const caught = vi.fn();
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: Error) {
        caught(error.message);
      }
      render() {
        return this.state.failed ? <div>Recovered</div> : this.props.children;
      }
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const childCleanup = vi.fn(() => {
      throw new Error('child cleanup');
    });
    const childRef = vi.fn<(node: HTMLButtonElement | null) => (() => void) | undefined>((node) => {
      if (node && phase === 'attach') throw new Error('child attach');
      return node ? childCleanup : undefined;
    });
    try {
      const view = (visible: boolean) => (
        <Boundary>
          <Trigger ref={owner} popup={<div>Tip</div>}>
            <Child visible={visible} ref={childRef} />
          </Trigger>
        </Boundary>
      );
      const { rerender, unmount } = render(view(true));
      if (phase === 'cleanup') {
        expect(owner.current?.nativeElement).toBe(screen.getByRole('button'));
        rerender(view(false));
        expect(childCleanup).toHaveBeenCalledTimes(1);
        expect(childRef.mock.calls.every(([node]) => node !== null)).toBe(true);
      } else {
        expect(childCleanup).not.toHaveBeenCalled();
      }
      expect(caught).toHaveBeenCalledWith(`child ${phase}`);
      expect(owner.current).toBeNull();
      expect(screen.getByText('Recovered').textContent).toBe('Recovered');
      unmount();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps live focus/keyboard targets and callback freshness; cancels pending hover on unmount', () => {
    vi.useFakeTimers();
    const oldChange = vi.fn();
    const newChange = vi.fn();
    const ownerRef = createRef<TriggerRef>();
    const view = (onOpenChange: (open: boolean) => void) => (
      <Trigger
        ref={ownerRef}
        popup={<div role="tooltip">Tip</div>}
        action={['hover', 'focus']}
        mouseEnterDelay={0.2}
        onOpenChange={onOpenChange}
      >
        <button type="button" aria-label="Target">
          Target
        </button>
      </Trigger>
    );
    const { rerender, unmount } = render(view(oldChange));
    rerender(view(newChange));
    fireEvent.focus(screen.getByRole('button'));
    expect(newChange).toHaveBeenLastCalledWith(true);
    expect(oldChange).not.toHaveBeenCalled();
    expect(ownerRef.current?.nativeElement).toBe(screen.getByRole('button'));
    fireEvent.blur(screen.getByRole('button'));
    act(() => vi.advanceTimersByTime(1000));
    newChange.mockClear();
    fireEvent.mouseEnter(screen.getByRole('button'));
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(newChange).not.toHaveBeenCalled();
    expect(ownerRef.current).toBeNull();
  });

  it('does not share target cells across concurrent or suspended owners', async () => {
    const a = createRef<TriggerRef>();
    const b = createRef<TriggerRef>();
    let release: () => void = () => {};
    let released = false;
    const pendingRender = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committedChild = createRef<HTMLButtonElement>();
    const pendingChild = vi.fn<(node: HTMLButtonElement | null) => void>();
    let suspend: () => void = () => {};
    function MaybeSuspended({ pending, ref }: { pending: boolean; ref?: Ref<HTMLButtonElement> }) {
      if (pending && !released) throw pendingRender;
      return (
        <button type="button" ref={ref}>
          Second
        </button>
      );
    }
    function Owners() {
      const [pending, setPending] = useState(false);
      const [visible, setVisible] = useState(true);
      suspend = () => {
        startTransition(() => setPending(true));
        setVisible(false);
      };
      return (
        <>
          <Trigger ref={a} popup={<div>A</div>}>
            <Child visible={visible} name="First" />
          </Trigger>
          <Suspense fallback={<div>Loading</div>}>
            <Trigger ref={b} popup={<div>B</div>}>
              <MaybeSuspended pending={pending} ref={pending ? pendingChild : committedChild} />
            </Trigger>
          </Suspense>
        </>
      );
    }
    const { unmount } = render(<Owners />);
    const second = b.current?.nativeElement;
    await act(async () => suspend());
    expect(a.current?.nativeElement).toBeNull();
    expect(b.current?.nativeElement).toBe(second);
    expect(screen.getByRole('button', { name: 'Second' })).toBe(second);
    expect(screen.queryByText('Loading')).toBeNull();
    expect(committedChild.current).toBe(second);
    expect(pendingChild).not.toHaveBeenCalled();
    await act(async () => {
      released = true;
      release();
    });
    expect(committedChild.current).toBeNull();
    expect(pendingChild).toHaveBeenLastCalledWith(second);
    expect(b.current?.nativeElement).toBe(second);
    expect(a.current?.nativeElement).toBeNull();
    unmount();
    expect(a.current).toBeNull();
    expect(b.current).toBeNull();
  });
});
