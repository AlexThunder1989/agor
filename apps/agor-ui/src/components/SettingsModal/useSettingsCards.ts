import type { AgorClient, Board, BoardEntityObject, CardWithType } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useAgorStore } from '@/store/agorStore';

/** Trailing delay that coalesces a burst of reconcile requests (reconnects). */
export const RECONCILE_DEBOUNCE_MS = 300;
/** A sustained burst still reconciles within this bound. */
export const RECONCILE_MAX_WAIT_MS = 2000;

export interface SettingsCards {
  cards: CardWithType[];
  /** Card placements (board objects with a `card_id`); empty for viewers. */
  placements: BoardEntityObject[];
  /** Full records (with zones) of the boards the placements reference. */
  zoneBoards: Map<string, Board>;
}

type Listener = (row: never) => void;
interface EventSource {
  on?: (event: string, listener: Listener) => unknown;
  removeListener?: (event: string, listener: Listener) => unknown;
}

/**
 * Every card the caller can see, for the settings Cards table. The store only
 * holds the cards of loaded boards, so the table reads its own dataset when it
 * opens: all cards, the card placements, and a `boards.get` for each board
 * whose zones a placement references (the boards list is lean).
 *
 * After that the dataset is patched from realtime events: card events, card
 * placement events (branch placements are ignored) and board record events
 * (zone labels). It is reconciled in full only when the socket reconnects
 * (events may have been missed) or the authority changes; those requests are
 * debounced with a bounded wait, and at most one read is in flight — a read
 * superseded while in flight is discarded and read again. Events that land
 * during a read keep their live value over the snapshot (per-id fence).
 */
export function useSettingsCards(
  client: AgorClient | null,
  options: { canReadPlacements: boolean }
): { data: SettingsCards | null; error: boolean } {
  const { canReadPlacements } = options;
  const [data, setData] = useState<SettingsCards | null>(null);
  const [error, setError] = useState(false);
  // A new authority (reauthentication, identity or role change) reloads it all.
  const authority = useAgorStore((s) => s.dataAuthority);

  useEffect(() => {
    if (!client || !authority) return;
    let disposed = false;
    const cards = new Map<string, CardWithType>();
    const placements = new Map<string, BoardEntityObject>();
    const zoneBoards = new Map<string, Board>();
    const boardReads = new Set<string>();
    // Ids an event wrote while a read was in flight: they keep their live value.
    const touched = new Set<string>();
    let loaded = false;
    let inflight = false;
    let superseded = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstRequestAt = 0;

    const publish = () => {
      if (disposed || !loaded) return;
      setData({
        cards: [...cards.values()],
        placements: [...placements.values()],
        zoneBoards: new Map(zoneBoards),
      });
    };

    const ensureZoneBoard = (boardId: string, force = false) => {
      if (boardReads.has(boardId) || (!force && zoneBoards.has(boardId))) return;
      boardReads.add(boardId);
      void (client.service('boards').get(boardId) as Promise<Board>)
        .then((board) => {
          if (disposed) return;
          zoneBoards.set(boardId, board);
          publish();
        })
        .catch(() => {
          // An unreadable board leaves its cards without a zone name.
        })
        .finally(() => boardReads.delete(boardId));
    };

    const read = async () => {
      if (inflight) {
        superseded = true;
        return;
      }
      inflight = true;
      superseded = false;
      touched.clear();
      let rerun = false;
      try {
        const [cardRows, placementRows] = await Promise.all([
          client
            .service('cards')
            .findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }) as Promise<CardWithType[]>,
          canReadPlacements
            ? (client.service('board-objects').findAll({
                query: { entity_type: 'card', $limit: PAGINATION.DEFAULT_LIMIT },
              }) as Promise<BoardEntityObject[]>)
            : Promise.resolve([] as BoardEntityObject[]),
        ]);
        if (disposed) return;
        if (superseded) {
          // Another reconcile was requested meanwhile: this snapshot may be
          // older than what triggered it. Discard it and read again.
          rerun = true;
          return;
        }
        const snapshot = (
          live: Map<string, { [key: string]: unknown }>,
          rows: Array<{ [key: string]: unknown }>,
          key: string,
          prefix: string
        ) => {
          const next = new Map(rows.map((row) => [row[key] as string, row]));
          for (const id of touched) {
            if (!id.startsWith(prefix)) continue;
            const liveId = id.slice(prefix.length);
            const row = live.get(liveId);
            if (row) next.set(liveId, row);
            else next.delete(liveId);
          }
          live.clear();
          for (const [id, row] of next) live.set(id, row);
        };
        snapshot(cards as never, cardRows as never, 'card_id', 'card:');
        snapshot(
          placements as never,
          placementRows.filter((row) => row.card_id) as never,
          'object_id',
          'placement:'
        );
        loaded = true;
        setError(false);
        publish();
        for (const placement of placements.values()) {
          if (placement.zone_id) ensureZoneBoard(placement.board_id);
        }
      } catch (err) {
        if (disposed) return;
        console.warn('[settings] failed to load cards:', err);
        setError(true);
      } finally {
        inflight = false;
        if (rerun && !disposed) void read();
      }
    };

    /** Debounced reconcile; a sustained burst still runs within the max wait. */
    const requestReconcile = () => {
      const now = Date.now();
      if (timer === null) firstRequestAt = now;
      else clearTimeout(timer);
      const delay = Math.max(
        0,
        Math.min(RECONCILE_DEBOUNCE_MS, firstRequestAt + RECONCILE_MAX_WAIT_MS - now)
      );
      timer = setTimeout(() => {
        timer = null;
        void read();
      }, delay);
    };

    const onCard = (card: CardWithType) => {
      if (inflight) touched.add(`card:${card.card_id}`);
      cards.set(card.card_id, card);
      publish();
    };
    const onCardRemoved = (card: CardWithType) => {
      if (inflight) touched.add(`card:${card.card_id}`);
      if (cards.delete(card.card_id)) publish();
    };
    const onPlacement = (placement: BoardEntityObject) => {
      if (!placement.card_id) return; // branch placements are not this table's
      if (inflight) touched.add(`placement:${placement.object_id}`);
      placements.set(placement.object_id, placement);
      if (placement.zone_id) ensureZoneBoard(placement.board_id);
      publish();
    };
    const onPlacementRemoved = (placement: BoardEntityObject) => {
      if (!placement.card_id) return;
      if (inflight) touched.add(`placement:${placement.object_id}`);
      if (placements.delete(placement.object_id)) publish();
    };
    const onBoard = (board: Board) => {
      if (!zoneBoards.has(board.board_id)) return;
      if (board.objects) {
        zoneBoards.set(board.board_id, board);
        publish();
      } else {
        ensureZoneBoard(board.board_id, true); // a lean event: read the zones
      }
    };

    const subscriptions: Array<[EventSource, string, Listener]> = [
      [client.service('cards') as unknown as EventSource, 'created', onCard as Listener],
      [client.service('cards') as unknown as EventSource, 'patched', onCard as Listener],
      [client.service('cards') as unknown as EventSource, 'updated', onCard as Listener],
      [client.service('cards') as unknown as EventSource, 'removed', onCardRemoved as Listener],
      [client.service('boards') as unknown as EventSource, 'patched', onBoard as Listener],
      [client.service('boards') as unknown as EventSource, 'updated', onBoard as Listener],
      [client.io as unknown as EventSource, 'connect', requestReconcile as Listener],
    ];
    if (canReadPlacements) {
      const objects = client.service('board-objects') as unknown as EventSource;
      subscriptions.push(
        [objects, 'created', onPlacement as Listener],
        [objects, 'patched', onPlacement as Listener],
        [objects, 'updated', onPlacement as Listener],
        [objects, 'removed', onPlacementRemoved as Listener]
      );
    }
    for (const [source, event, listener] of subscriptions) source.on?.(event, listener);
    void read();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const [source, event, listener] of subscriptions) {
        source.removeListener?.(event, listener);
      }
    };
  }, [client, canReadPlacements, authority]);

  return { data, error };
}
