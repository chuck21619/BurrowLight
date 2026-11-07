import type { ClientMessage, ServerMessage } from '@burrowlight/shared';

/** Thin WebSocket wrapper. Reconnecting is decided by the caller (main.ts). */
export class Net {
  private ws: WebSocket | null = null;
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: () => void = () => {};

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    this.ws?.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the server.'));
      ws.onmessage = (e) => {
        try {
          this.onMessage(JSON.parse(e.data as string) as ServerMessage);
        } catch (err) {
          console.error('bad message', err);
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onClose();
        }
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }
}
