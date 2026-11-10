// Phase 3: Chromium per group on a virtual display → QuickSync H.264 → doubletake (AirPlay)
// or HLS segments. Stubbed until it can be built and measured on real TVs.

import type { DisplayDevice, ShowResult, StreamService } from "./types.js";
import { NotBuiltYet } from "./types.js";

export class PendingStreamService implements StreamService {
  async startAirplay(device: DisplayDevice): Promise<ShowResult> {
    return { ok: false, message: `AirPlay delivery to ${device.name} is not built yet (Phase 3)` };
  }
  async hlsUrl(): Promise<string> {
    throw new NotBuiltYet("HLS delivery is not built yet (Phase 3)");
  }
  async stopFor(): Promise<void> {}
}
