import { describe, expect, it } from 'vitest';
import {
  formatActionError,
  isConnectionLossError,
  NOT_CONNECTED_ERROR,
  NOT_CONNECTED_RETRY_ERROR,
  SOCKET_ACK_TIMEOUT_ERROR,
  SOCKET_DISCONNECTED_ERROR,
} from './connectionErrors';

describe('isConnectionLossError', () => {
  it.each([
    'socket has been disconnected',
    'operation has timed out',
    'Error: socket has been disconnected',
    'Error: operation has timed out',
    'Not connected to daemon',
    'Not connected - try again when Agor reconnects.',
  ])('recognises %j', (message) => {
    expect(isConnectionLossError(new Error(message))).toBe(true);
    expect(isConnectionLossError(message)).toBe(true);
    expect(isConnectionLossError({ message })).toBe(true);
  });

  it('exports the exact library and app strings', () => {
    expect(SOCKET_DISCONNECTED_ERROR).toBe('socket has been disconnected');
    expect(SOCKET_ACK_TIMEOUT_ERROR).toBe('operation has timed out');
    expect(NOT_CONNECTED_ERROR).toBe('Not connected to daemon');
    expect(NOT_CONNECTED_RETRY_ERROR).toBe('Not connected - try again when Agor reconnects.');
  });

  it.each([
    'Session is busy',
    'the socket has been disconnected by the server',
    'Socket Has Been Disconnected',
    '',
  ])('rejects %j', (message) => {
    expect(isConnectionLossError(new Error(message))).toBe(false);
  });

  it.each([null, undefined, 42])('rejects non-error value %j', (value) => {
    expect(isConnectionLossError(value)).toBe(false);
  });
});

describe('formatActionError', () => {
  it('leads with plain copy and keeps the raw detail in brackets', () => {
    expect(formatActionError('archive the branch', new Error(SOCKET_DISCONNECTED_ERROR))).toBe(
      "Couldn't archive the branch. The connection to Agor dropped. Try again once it's back. (socket has been disconnected)"
    );
    expect(formatActionError('update the board', 'Error: operation has timed out')).toBe(
      "Couldn't update the board. The connection to Agor dropped. Try again once it's back. (operation has timed out)"
    );
  });

  it.each([
    'create the session',
    'fork the session',
    'start the side question',
    'spawn the subsession',
    'archive the branch',
    'delete the branch',
    'update the branch',
    'create the branch',
    'create the board',
    'update the board',
    'delete the board',
    'archive the board',
    'unarchive the board',
  ])('ends with the bracketed detail and no added full stop for %j', (action) => {
    expect(formatActionError(action, new Error(SOCKET_DISCONNECTED_ERROR))).toBe(
      `Couldn't ${action}. The connection to Agor dropped. Try again once it's back. (socket has been disconnected)`
    );
  });

  it('keeps the existing format for other errors', () => {
    expect(formatActionError('update the board', new Error('Board name required'))).toBe(
      'Failed to update the board: Board name required'
    );
    expect(formatActionError('update the board', 'nope')).toBe('Failed to update the board: nope');
  });
});
