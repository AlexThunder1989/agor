/** socket.io-client rejects a pending acknowledgement with these when the transport drops. */
export const SOCKET_DISCONNECTED_ERROR = 'socket has been disconnected';
export const SOCKET_ACK_TIMEOUT_ERROR = 'operation has timed out';

/** Thrown by the UI itself when an action starts without a live client. */
export const NOT_CONNECTED_ERROR = 'Not connected to daemon';
export const NOT_CONNECTED_RETRY_ERROR = 'Not connected - try again when Agor reconnects.';

const CONNECTION_LOSS_MESSAGES: ReadonlySet<string> = new Set([
  SOCKET_DISCONNECTED_ERROR,
  SOCKET_ACK_TIMEOUT_ERROR,
  NOT_CONNECTED_ERROR,
  NOT_CONNECTED_RETRY_ERROR,
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

function connectionErrorDetail(error: unknown): string {
  return errorMessage(error).replace(/^Error: /, '');
}

export function isConnectionLossError(error: unknown): boolean {
  return CONNECTION_LOSS_MESSAGES.has(connectionErrorDetail(error));
}

/** Appends the raw error in brackets so technical readers (and Copy) still see it. */
export function withConnectionErrorDetail(message: string, error: unknown): string {
  return `${message} (${connectionErrorDetail(error)})`;
}

/** Toast copy for a failed action phrase, e.g. `formatActionError('update the board', error)`. */
export function formatActionError(action: string, error: unknown): string {
  if (isConnectionLossError(error)) {
    return withConnectionErrorDetail(
      `Couldn't ${action}. The connection to Agor dropped. Try again once it's back.`,
      error
    );
  }
  return `Failed to ${action}: ${errorMessage(error)}`;
}
