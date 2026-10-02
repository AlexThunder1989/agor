import type { AgorClient, Board, CardType, CardWithType } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardCreated } from '../../store/agorRealtimeActions';
import { agorStore } from '../../store/agorStore';
import { CardsTable } from './CardsTable';

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
const fullBoard = {
  ...leanBoard,
  objects: { 'zone-1': { type: 'zone', label: 'Review', x: 0, y: 0, width: 1, height: 1 } },
} as unknown as Board;

function makeClient(cards: CardWithType[]) {
  const cardsFindAll = vi.fn(async () => cards);
  const placementsFindAll = vi.fn(async () => [
    {
      object_id: 'o-1',
      board_id: 'board-unloaded',
      card_id: 'k-1',
      zone_id: 'zone-1',
      entity_type: 'card',
    },
  ]);
  const boardsGet = vi.fn(async () => fullBoard);
  const client = {
    service: (name: string) =>
      name === 'cards'
        ? { findAll: cardsFindAll }
        : name === 'board-objects'
          ? { findAll: placementsFindAll }
          : { get: boardsGet },
  } as unknown as AgorClient;
  return { client, cardsFindAll, placementsFindAll, boardsGet };
}

describe('CardsTable', () => {
  beforeEach(() => agorStore.getState().reset());

  it('reads every card on open, not just the loaded boards in the store', async () => {
    const { client, cardsFindAll, placementsFindAll, boardsGet } = makeClient([
      card('k-1', 'Fix login'),
    ]);
    render(
      <CardsTable
        client={client}
        cardTypeById={new Map([['type-1', cardType]])}
        boardById={new Map([['board-unloaded', leanBoard]])}
      />
    );
    fireEvent.click(screen.getByText('Ticket'));
    expect(await screen.findByText('Fix login')).toBeVisible();
    // The zone name comes from the board's full record.
    expect(await screen.findByText('Review')).toBeVisible();
    expect(cardsFindAll).toHaveBeenCalledTimes(1);
    expect(placementsFindAll).toHaveBeenCalledWith({
      query: expect.objectContaining({ entity_type: 'card' }),
    });
    expect(boardsGet).toHaveBeenCalledWith('board-unloaded');
  });

  it('refetches when a card event arrives', async () => {
    const cards = [card('k-1', 'Fix login')];
    const { client, cardsFindAll } = makeClient(cards);
    render(
      <CardsTable
        client={client}
        cardTypeById={new Map([['type-1', cardType]])}
        boardById={new Map([['board-unloaded', leanBoard]])}
      />
    );
    fireEvent.click(screen.getByText('Ticket'));
    await screen.findByText('Fix login');

    cards.push(card('k-2', 'New ticket'));
    act(() => cardCreated(card('k-2', 'New ticket')));
    await waitFor(() => expect(cardsFindAll).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(await screen.findByText('New ticket')).toBeVisible();
  });
});
