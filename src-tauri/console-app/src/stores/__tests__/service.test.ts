import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { consoleStartService, consoleStopService, consoleOpenWebui } = vi.hoisted(() => ({
  consoleStartService: vi.fn(),
  consoleStopService: vi.fn(),
  consoleOpenWebui: vi.fn(),
}));

vi.mock("../../ipc/commands", () => ({
  consoleStartService,
  consoleStopService,
  consoleOpenWebui,
}));

import { useServiceStore } from "../service";

describe("service store start", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    consoleStartService.mockReset().mockResolvedValue(8899);
    consoleStopService.mockReset().mockResolvedValue(undefined);
    consoleOpenWebui.mockReset().mockResolvedValue(true);
  });

  it("quiet start marks the service running without opening WebUI", async () => {
    const store = useServiceStore();

    await expect(store.start({ openWebui: false })).resolves.toBe(8899);

    expect(consoleStartService).toHaveBeenCalledOnce();
    expect(store.running).toBe(true);
    expect(consoleOpenWebui).not.toHaveBeenCalled();
  });

  it("default start still opens WebUI", async () => {
    const store = useServiceStore();

    await store.start();

    expect(consoleOpenWebui).toHaveBeenCalledWith(8899);
  });
});
