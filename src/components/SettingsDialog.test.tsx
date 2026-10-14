import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsDialog } from "./SettingsDialog";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/lib/store";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    isWindows: vi.fn(),
    checkCliShim: vi.fn(),
    cliProvidedByPackage: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.0.0")),
}));

vi.mock("@/components/plugins/PluginsSettings", () => ({
  PluginsSettings: () => null,
}));

function openIntegrations() {
  render(<SettingsDialog />);
  fireEvent.click(screen.getByRole("button", { name: /integrations/i }));
}

describe("SettingsDialog terminal command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.isWindows).mockResolvedValue(false);
    vi.mocked(ipc.checkCliShim).mockResolvedValue(false);
    useStore.setState({ settingsOpen: true } as any);
  });

  it("offers the toggle once it knows the package manager doesn't provide the command", async () => {
    vi.mocked(ipc.cliProvidedByPackage).mockResolvedValue(false);
    openIntegrations();
    expect(await screen.findByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText(/installed by your package manager/i)).not.toBeInTheDocument();
  });

  it("hides the toggle when the package manager provides the command", async () => {
    vi.mocked(ipc.cliProvidedByPackage).mockResolvedValue(true);
    openIntegrations();
    expect(await screen.findByText(/installed by your package manager/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("still lets a package install remove a shim it registered earlier", async () => {
    vi.mocked(ipc.cliProvidedByPackage).mockResolvedValue(true);
    vi.mocked(ipc.checkCliShim).mockResolvedValue(true);
    openIntegrations();
    expect(await screen.findByRole("checkbox")).toBeChecked();
  });
});
