import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndroidAppPreparationService } from "../../src/services/install/android-app-preparation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const bytes = Buffer.from("signed-apk-fixture");
const manifest = {
  version: "0.39.0",
  versionCode: 17,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
async function root() {
  const path = await mkdtemp(join(tmpdir(), "bb-android-prepare-"));
  roots.push(path);
  return path;
}
async function publish(dataDir: string) {
  const path = join(dataDir, "android-testing");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, `${manifest.sha256}.apk`), bytes);
  await writeFile(join(path, "latest.json"), JSON.stringify(manifest));
}
async function complete(
  service: ReturnType<typeof createAndroidAppPreparationService>,
) {
  await vi.waitFor(async () =>
    expect((await service.status()).status).not.toBe("preparing"),
  );
  return service.status();
}

describe("Android APK fetching and explicit local builds", () => {
  it("deduplicates requests, checks the checksum, publishes atomically, and reuses the cache", async () => {
    const dataDir = await root();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) =>
        String(input).endsWith("latest.json")
          ? Response.json(manifest)
          : new Response(bytes),
      );
    const buildLocal = vi.fn();
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch,
      buildLocal,
    });
    service.start("github");
    service.start("local");
    expect((await complete(service)).status).toBe("ready");
    expect(buildLocal).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      await readFile(
        join(dataDir, "android-testing", `${manifest.sha256}.apk`),
      ),
    ).toEqual(bytes);
    service.start("github");
    await complete(service);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readdir(join(dataDir, "android-testing"))).toEqual(
      expect.arrayContaining(["latest.json", `${manifest.sha256}.apk`]),
    );
  });
  it("uses the cached APK if GitHub is unavailable", async () => {
    const dataDir = await root();
    await publish(dataDir);
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    service.start("github");
    expect(await complete(service)).toMatchObject({
      status: "ready",
      artifact: manifest,
      message: expect.stringContaining("cached"),
    });
  });
  it.each(["checksum", "truncated", "oversized"])(
    "rejects a %s mismatch without publishing partial files",
    async (mismatch) => {
      const dataDir = await root();
      const bad =
        mismatch === "checksum"
          ? Buffer.alloc(bytes.length)
          : mismatch === "truncated"
            ? bytes.subarray(1)
            : Buffer.concat([bytes, bytes]);
      const service = createAndroidAppPreparationService({
        dataDir,
        fetch: vi
          .fn<typeof fetch>()
          .mockImplementation(async (input) =>
            String(input).endsWith("latest.json")
              ? Response.json(manifest)
              : new Response(bad),
          ),
      });
      service.start("github");
      expect((await complete(service)).status).toBe("failed");
      expect(await readdir(join(dataDir, "android-testing"))).toEqual([]);
    },
  );
  it("keeps a cached build when a new release fails integrity checks", async () => {
    const dataDir = await root();
    await publish(dataDir);
    const next = { ...manifest, versionCode: 18, sha256: "a".repeat(64) };
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input).endsWith("latest.json")
            ? Response.json(next)
            : new Response(bytes),
        ),
    });
    service.start("github");
    expect((await complete(service)).status).toBe("failed");
    expect(
      JSON.parse(
        await readFile(join(dataDir, "android-testing", "latest.json"), "utf8"),
      ),
    ).toEqual(manifest);
  });

  it("cleans up an interrupted download", async () => {
    const dataDir = await root();
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch: vi.fn<typeof fetch>().mockImplementation(async (input) =>
        String(input).endsWith("latest.json")
          ? Response.json(manifest)
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes.subarray(0, 3));
                  controller.error(
                    new Error("Connection interrupted. Retry the download."),
                  );
                },
              }),
            ),
      ),
    });
    service.start("github");
    expect((await complete(service)).status).toBe("failed");
    expect(await readdir(join(dataDir, "android-testing"))).toEqual([]);
  });

  it("reports a missing release and never starts a local build implicitly", async () => {
    const dataDir = await root();
    const buildLocal = vi.fn(async () => {
      throw new Error("Java is missing. Install JDK 17 or newer.");
    });
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 404 })),
      buildLocal,
    });
    service.start("github");
    expect(await complete(service)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("No Android APK"),
    });
    expect(buildLocal).not.toHaveBeenCalled();
    service.start("local");
    expect(await complete(service)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Java is missing"),
    });
    expect(buildLocal).toHaveBeenCalledTimes(1);
  });
  it("reports progress and publishes only after an explicit local build", async () => {
    const dataDir = await root();
    const service = createAndroidAppPreparationService({
      dataDir,
      buildLocal: async (progress) => {
        progress("Building…");
        await publish(dataDir);
      },
    });
    service.start("local");
    expect(await complete(service)).toMatchObject({
      status: "ready",
      source: "local",
      artifact: manifest,
    });
  });
  it.each([
    "not json",
    JSON.stringify({ ...manifest, sha256: "../../other" }),
    "x".repeat(17000),
  ])("rejects malformed release metadata", async (metadata) => {
    const dataDir = await root();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(metadata));
    const service = createAndroidAppPreparationService({
      dataDir,
      fetch: request,
    });
    service.start("github");
    expect((await complete(service)).status).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
