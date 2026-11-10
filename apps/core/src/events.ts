import type { BarGamesEvent } from "@bargames/sdk";

/** Something that receives every event (Home Assistant via MQTT, webhooks, …). */
export interface EventSink {
  readonly name: string;
  send(evt: BarGamesEvent): Promise<void>;
}

type Listener = (evt: BarGamesEvent) => void;

/** One bus for all game and platform events. Games just emit; sinks fan out. */
export class EventBus {
  private readonly recent: BarGamesEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly sinks: EventSink[] = [];

  constructor(private readonly keep = 200, private readonly onSinkError?: (sink: string, err: unknown) => void) {}

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  publish(evt: BarGamesEvent): void {
    this.recent.push(evt);
    if (this.recent.length > this.keep) this.recent.shift();
    for (const l of this.listeners) l(evt);
    for (const s of this.sinks) s.send(evt).catch((err) => this.onSinkError?.(s.name, err));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  latest(limit = 50, gameId?: string): BarGamesEvent[] {
    const list = gameId ? this.recent.filter((e) => e.gameId === gameId) : this.recent;
    return list.slice(-limit).reverse();
  }
}

// TODO(phase 4): MqttSink publishing to homeassistant/… with MQTT discovery.
