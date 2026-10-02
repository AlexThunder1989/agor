import type { AgorClient, Board, BoardEntityObject, CardWithType } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { agorStore, useAgorStore } from '@/store/agorStore';

/** Coalesces a burst of card or placement events into one refetch. */
const REFETCH_DEBOUNCE_MS = 500;

export interface SettingsCards {
  cards: CardWithType[];
  /** Card placements (board objects with a `card_id`); empty for viewers. */
  placements: BoardEntityObject[];
  /** Full records (with zones) of the boards the placements reference. */
  zoneBoards: Map<string, Board>;
}

/**
 * Every card the caller can see, for the settings Cards table. The store only
 * holds the cards of loaded boards, so the table reads its own set when it
 * opens: all cards, the card placements, and a `boards.get` for each board
 * whose zones a placement references (the boards list is lean). A card or
 * placement event (they reach every connection) refetches, debounced.
 */
export function useSettingsCards(
  client: AgorClient | null,
  options: { canReadPlacements: boolean }
): { data: SettingsCards | null; error: boolean } {
  const { canReadPlacements } = options;
  const [data, setData] = useState<SettingsCards | null>(null);
  const [error, setError] = useState(false);
  // Board records fetched while the table is open; zone layouts rarely change.
  const fetchedBoards = useRef(new Map<string, Board>());
  const loadedOnce = useRef(false);
  const cardsRevision = useAgorStore((s) => s.cardById);
  const placementsRevision = useAgorStore((s) => s.boardObjectById);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the store slices are refetch triggers
  useEffect(() => {
    if (!client) return;
    let active = true;
    const load = async () => {
      try {
        const [cards, placements] = await Promise.all([
          client
            .service('cards')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }) as Promise<CardWithType[]>,
          canReadPlacements
            ? (client.service('board-objects').findAll({
                query: { entity_type: 'card', $limit: PAGINATION.DEFAULT_LIMIT },
              }) as Promise<BoardEntityObject[]>)
            : Promise.resolve([] as BoardEntityObject[]),
        ]);
        const zoneBoards = new Map<string, Board>();
        const boardIds = new Set(
          placements.filter((p) => p.card_id && p.zone_id).map((p) => p.board_id)
        );
        await Promise.all(
          [...boardIds].map(async (boardId) => {
            const known =
              agorStore.getState().boardById.get(boardId) ?? fetchedBoards.current.get(boardId);
            if (known?.objects) {
              zoneBoards.set(boardId, known);
              return;
            }
            try {
              const board = (await client.service('boards').get(boardId)) as Board;
              fetchedBoards.current.set(boardId, board);
              zoneBoards.set(boardId, board);
            } catch {
              // An unreadable board leaves its cards without a zone name.
            }
          })
        );
        if (!active) return;
        loadedOnce.current = true;
        setData({ cards, placements, zoneBoards });
        setError(false);
      } catch (err) {
        if (!active) return;
        console.warn('[settings] failed to load cards:', err);
        setError(true);
      }
    };
    const timer = setTimeout(() => void load(), loadedOnce.current ? REFETCH_DEBOUNCE_MS : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, canReadPlacements, cardsRevision, placementsRevision]);

  return { data, error };
}
