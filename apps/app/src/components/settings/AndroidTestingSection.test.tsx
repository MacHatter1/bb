// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AndroidAppPreparation } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { AndroidTestingSection } from "./AndroidTestingSection";

const idle: AndroidAppPreparation = {
  status: "idle",
  source: null,
  message: "",
  artifact: null,
};
const ready: AndroidAppPreparation = {
  status: "ready",
  source: "github",
  message: "APK ready to download.",
  artifact: {
    version: "0.39.0",
    versionCode: 17,
    size: 1024,
    sha256: "a".repeat(64),
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function renderSection() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AndroidTestingSection />
    </QueryClientProvider>,
  );
}
it("offers Download APK before any build exists and downloads after fetching", async () => {
  vi.spyOn(sdk.system, "androidAppPreparation").mockResolvedValue(idle);
  const prepare = vi
    .spyOn(sdk.system, "prepareAndroidApp")
    .mockResolvedValue(ready);
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  renderSection();
  const button = await screen.findByRole("button", { name: "Download APK" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(prepare).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(prepare).toHaveBeenCalledWith({ source: "github" });
  expect(screen.getByText(/Version 0.39.0 · Build 17/)).toBeTruthy();
});
it("offers a local build only after failure and only runs it when clicked", async () => {
  vi.spyOn(sdk.system, "androidAppPreparation").mockResolvedValue(idle);
  const prepare = vi.spyOn(sdk.system, "prepareAndroidApp").mockResolvedValue({
    status: "failed",
    source: "github",
    message: "No Android APK has been published to GitHub yet.",
    artifact: null,
  });
  renderSection();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Download APK" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(
    screen.queryByRole("button", { name: "Build on this server" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download APK" }));
  const local = await screen.findByRole("button", {
    name: "Build on this server",
  });
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockResolvedValue({
    status: "failed",
    source: "local",
    message: "Java is missing. Install JDK 17 or newer.",
    artifact: null,
  });
  fireEvent.click(local);
  await screen.findByText("Java is missing. Install JDK 17 or newer.");
  expect(prepare).toHaveBeenLastCalledWith({ source: "local" });
});
it("polls a running download and disables duplicate clicks", async () => {
  const status = vi
    .spyOn(sdk.system, "androidAppPreparation")
    .mockResolvedValue(idle);
  vi.spyOn(sdk.system, "prepareAndroidApp").mockResolvedValue({
    status: "preparing",
    source: "github",
    message: "Downloading Android APK… 50%",
    artifact: null,
  });
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  renderSection();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Download APK" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download APK" }));
  await screen.findByText("Downloading Android APK… 50%");
  expect(
    screen
      .getByRole("button", { name: "Downloading APK…" })
      .hasAttribute("disabled"),
  ).toBe(true);
  status.mockResolvedValue(ready);
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1), {
    timeout: 3000,
  });
});
it("does not start a download just from viewing a ready build", async () => {
  vi.spyOn(sdk.system, "androidAppPreparation").mockResolvedValue(ready);
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  renderSection();
  await screen.findByRole("link", { name: "Download ready APK" });
  expect(download).not.toHaveBeenCalled();
});
