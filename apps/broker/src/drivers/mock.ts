import type { Capabilities, DisplayContent, DisplayDevice, DisplayDriver, Health, ShowResult } from "../types.js";

/** Virtual TVs for development and the admin UI (MOCK_DISPLAYS=3). */
export class MockDriver implements DisplayDriver {
  readonly id = "mock";
  readonly shown = new Map<string, DisplayContent>();
  readonly powered = new Map<string, boolean>();

  constructor(private readonly count: number) {}

  async discover(): Promise<DisplayDevice[]> {
    return Array.from({ length: this.count }, (_, i) => ({
      id: `mock:tv${i + 1}`,
      driver: this.id,
      name: `Mock TV ${i + 1}`,
      address: `mock://tv${i + 1}`,
      model: "Virtual display",
      isTv: true,
    }));
  }

  async capabilities(): Promise<Capabilities> {
    return { delivery: ["mock"], power: true, inputs: ["hdmi1", "hdmi2", "hdmi3"] };
  }

  async power(d: DisplayDevice, on: boolean) {
    this.powered.set(d.id, on);
  }

  async setInput() {}

  async show(d: DisplayDevice, content: DisplayContent): Promise<ShowResult> {
    this.shown.set(d.id, content);
    return { ok: true, delivery: "mock" };
  }

  async stop(d: DisplayDevice) {
    this.shown.delete(d.id);
  }

  async health(d: DisplayDevice): Promise<Health> {
    return { online: true, powerMode: this.powered.get(d.id) === false ? "DisplayOff" : "PowerOn" };
  }
}
