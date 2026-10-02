import { EventEmitter } from 'node:events';
import type { AgorClient, Board, CardType, CardWithType } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardObjectCreated,
  boardObjectPatched,
  boardObjectRemoved,
} from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { CardsTable } from './CardsTable';
import { RECONCILE_MAX_WAIT_MS } from './useSettingsCards';

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ hasRole: () => true, isAdmin: true, role: 'admin' }),
}));
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const cardType = { card_type_id: 'type-1', name: 'Ticket', emoji: '🎫' } as CardType;
const card = (id: string, title: string, boardId = 'board-unloaded') =>
  ({ card_id: id, card_type_id: 'type-1', board_id: boardId, title }) as CardWithType;
// The store's lean board row has no zones; only `boards.get` returns them.
const leanBoard = { board_id: 'board-unloaded', name: 'Unloaded' } as Board;
const fullBoard = (label = 'Review') =>
  ({
    ...leanBoard,
    objects: { 'zone-1': { type: 'zone', label, x: 0, y: 0, width: 1, height: 1 } },
  }) as unknown as Board;
const cardPlacement = {
  object_id: 'o-1',
  board_id: 'board-unloaded',
  card_id: 'k-1',
  zone_id: 'zone-1',
  entity_type: 'card',
};

/** A client whose services and socket emit events like Feathers'. */
function makeClient(cards: CardWithType[]) {
  const emitters = new Map<string, EventEmitter>();
  const emitter = (name: string) => {
    let e = emitters.get(name);
    if (!e) {
      e = new EventEmitter();
      emitters.set(name, e);
    }
    return e;
  };
  const cardsFindAll = vi.fn(async () => [...cards]);
  const placementsFindAll = vi.fn(async () => [cardPlacement]);
  const boardsGet = vi.fn(async () => fullBoard());
  const listen = (name: string) => ({
    on: (event: string, fn: (...args: unknown[]) => void) => emitter(name).on(event, fn),
    removeListener: (event: string, fn: (...args: unknown[]) => void) =>
      emitter(name).removeListener(event, fn),
  });
  const client = {
    service: (name: string) => ({
      ...listen(name),
      ...(name === 'cards'
        ? { findAll: cardsFindAll }
        : name === 'board-objects'
          ? { findAll: placementsFindAll }
          : { get: boardsGet }),
    }),
    io: listen('io'),
  } as unknown as AgorClient;
  const emit = (name: string, event: string, payload?: unknown) =>
    act(() => {
      emitter(name).emit(event, payload);
    });
  return { client, emit, cardsFindAll, placementsFindAll, boardsGet };
}

function renderTable(client: AgorClient) {
  render(
    <CardsTable
      client={client}
      cardTypeById={new Map([['type-1', cardType]])}
      boardById={new Map([['board-unloaded', leanBoard]])}
    />
  );
  fireEvent.click(screen.getByText('Ticket'));
}

describe('CardsTable', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    setRealtimeAuthorityScope('user-a:admin:1');
  });
  afterEach(() => setRealtimeAuthorityScope(null));

  it('reads every card on open, not just the loaded boards in the store', async () => {
    const { client, cardsFindAll, placementsFindAll, boardsGet } = makeClient([
      card('k-1', 'Fix login'),
    ]);
    renderTable(client);
    expect(await screen.findByText('Fix login')).toBeVisible();
    // The zone name comes from the board's full record.
    expect(await screen.findByText('Review')).toBeVisible();
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledWith({
      query: expect.objectContaining({ entity_type: 'card' }),
    });
    expect(boardsGet).toHaveBeenCalledWith('board-unloaded');
  });

  it('patches the dataset from card events without reading again', async () => {
    const { client, emit, cardsFindAll } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    await screen.findByText('Fix login');

    emit('cards', 'created', card('k-2', 'New ticket'));
    emit('cards', 'patched', card('k-1', 'Fix login (renamed)'));
    expect(await screen.findByText('New ticket')).toBeVisible();
    expect(await screen.findByText('Fix login (renamed)')).toBeVisible();
    emit('cards', 'removed', card('k-2', 'New ticket'));
    await waitFor(() => expect(screen.queryByText('New ticket')).not.toBeInTheDocument());
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
  });

  it('ignores branch placement events: three of them read nothing', async () => {
    const { client, emit, cardsFindAll, placementsFindAll } = makeClient([
      card('k-1', 'Fix login'),
    ]);
    renderTable(client);
    await screen.findByText('Fix login');
    // As in the app, each event reaches this table and the store (useAgorData).
    const branchPlacement = { object_id: 'o-b', board_id: 'b', branch_id: 'br-1' } as never;
    const store = {
      created: boardObjectCreated,
      patched: boardObjectPatched,
      removed: boardObjectRemoved,
    };
    for (const event of ['created', 'patched', 'removed'] as const) {
      emit('board-objects', event, branchPlacement);
      act(() => store[event](branchPlacement));
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledTimes(1);
  });

  it('reconciles once for a burst of reconnects', async () => {
    const cards = [card('k-1', 'Fix login')];
    const { client, emit, cardsFindAll } = makeClient(cards);
    renderTable(client);
    await screen.findByText('Fix login');

    // Missed while disconnected: a card was deleted and another created.
    cards.splice(0, 1, card('k-3', 'Created while offline'));
    emit('io', 'connect');
    emit('io', 'connect');
    emit('io', 'connect');
    expect(await screen.findByText('Created while offline')).toBeVisible();
    expect(screen.queryByText('Fix login')).not.toBeInTheDocument();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
  });

  it('a sustained burst still reconciles within the max wait', async () => {
    const { client, emit, cardsFindAll } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    await screen.findByText('Fix login');
    const started = Date.now();
    while (
      Date.now() - started < RECONCILE_MAX_WAIT_MS + 400 &&
      cardsFindAll.mock.calls.length < 2
    ) {
      emit('io', 'connect');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    }
    expect(cardsFindAll).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(RECONCILE_MAX_WAIT_MS + 400);
  });

  it('updates a zone label when the board record changes', async () => {
    const { client, emit } = makeClient([card('k-1', 'Fix login')]);
    renderTable(client);
    expect(await screen.findByText('Review')).toBeVisible();

    emit('boards', 'patched', fullBoard('In review'));
    expect(await screen.findByText('In review')).toBeVisible();
  });
});
