import { createHash, randomUUID } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  androidAppArtifactSchema,
  type AndroidAppPreparation,
  type AndroidAppPrepareRequest,
} from "@bb/server-contract";
import { readAndroidAppArtifact } from "./android-app-artifact.js";
import { buildAndroidAppLocally } from "./android-app-local-build.js";

const RELEASE_URL =
  "https://github.com/get-bb/bb/releases/download/android-testing";
const MAX_APK_BYTES = 512 * 1024 * 1024;

class ReleaseUnavailableError extends Error {}

async function readReleaseManifest(response: Response) {
  if (!response.body) throw new Error("The Android release metadata is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16_384)
      throw new Error("The Android release metadata is too large.");
    chunks.push(chunk);
  }
  try {
    return androidAppArtifactSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    throw new Error(
      "The Android release metadata is invalid. Retry after the release is corrected, or build on this server.",
    );
  }
}

export function createAndroidAppPreparationService(options: {
  dataDir: string;
  fetch?: typeof fetch;
  buildLocal?: (progress: (message: string) => void) => Promise<void>;
}) {
  let state: AndroidAppPreparation = {
    status: "idle",
    source: null,
    message: "",
    artifact: null,
  };
  let running = false;
  const request = options.fetch ?? fetch;
  const directory = join(options.dataDir, "android-testing");

  async function fetchRelease(url: string, signal: AbortSignal) {
    try {
      return await request(url, { signal });
    } catch {
      throw new ReleaseUnavailableError(
        "Could not reach GitHub. Check this server's internet connection, then retry or build on this server.",
      );
    }
  }

  async function downloadRelease() {
    const signal = AbortSignal.timeout(15 * 60_000);
    const response = await fetchRelease(`${RELEASE_URL}/latest.json`, signal);
    if (!response.ok)
      throw new ReleaseUnavailableError(
        response.status === 404
          ? "No Android APK has been published to GitHub yet. Retry later or build on this server."
          : `GitHub could not provide the Android build (HTTP ${response.status}). Retry or build on this server.`,
      );
    const manifest = await readReleaseManifest(response);
    if (manifest.size > MAX_APK_BYTES)
      throw new Error("The Android release exceeds the 512 MB download limit.");
    const cached = await readAndroidAppArtifact(options.dataDir);
    if (cached?.manifest.sha256 === manifest.sha256) return cached.manifest;
    state = { ...state, message: "Downloading Android APK from GitHub…" };
    const download = await fetchRelease(
      `${RELEASE_URL}/${manifest.sha256}.apk`,
      signal,
    );
    if (!download.ok || !download.body)
      throw new ReleaseUnavailableError(
        `The Android APK could not be downloaded (HTTP ${download.status}). Retry or build on this server.`,
      );
    await mkdir(directory, { recursive: true });
    const staging = join(directory, `${randomUUID()}.tmp`);
    const file = await open(staging, "wx");
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of download.body) {
        size += chunk.byteLength;
        if (size > manifest.size)
          throw new Error(
            "The downloaded APK is larger than its release metadata. Retry after the release is corrected.",
          );
        hash.update(chunk);
        await file.writeFile(chunk);
        state = {
          ...state,
          message: `Downloading Android APK… ${Math.floor((size / manifest.size) * 100)}%`,
        };
      }
      if (size !== manifest.size || hash.digest("hex") !== manifest.sha256)
        throw new Error(
          "The downloaded APK failed checksum verification. It was not published. Retry after the release is corrected.",
        );
      await file.close();
      await rename(staging, join(directory, `${manifest.sha256}.apk`));
      await writeFile(staging, JSON.stringify(manifest) + "\n");
      await rename(staging, join(directory, "latest.json"));
      return manifest;
    } finally {
      await file.close();
      await rm(staging, { force: true });
    }
  }

  async function prepare(source: AndroidAppPrepareRequest["source"]) {
    try {
      if (source === "github") {
        const artifact = await downloadRelease();
        state = {
          status: "ready",
          source,
          message: "APK ready to download.",
          artifact,
        };
      } else {
        const progress = (message: string) => {
          state = { ...state, message };
        };
        await (
          options.buildLocal ??
          ((report) => buildAndroidAppLocally(options.dataDir, report))
        )(progress);
        const artifact = await readAndroidAppArtifact(options.dataDir);
        if (!artifact)
          throw new Error(
            "The local build did not produce a complete APK. Check android-testing/build.log in the server data directory.",
          );
        state = {
          status: "ready",
          source,
          message: "Local APK ready to download.",
          artifact: artifact.manifest,
        };
      }
    } catch (error) {
      const cached =
        source === "github" && error instanceof ReleaseUnavailableError
          ? await readAndroidAppArtifact(options.dataDir).catch(() => null)
          : null;
      state = cached
        ? {
            status: "ready",
            source,
            artifact: cached.manifest,
            message: "GitHub is unavailable. Using the cached APK.",
          }
        : {
            status: "failed",
            source,
            artifact: null,
            message:
              error instanceof Error
                ? error.message
                : "Could not prepare the Android APK.",
          };
    } finally {
      running = false;
    }
  }

  return {
    async status(): Promise<AndroidAppPreparation> {
      if (state.status !== "idle") return state;
      const artifact = await readAndroidAppArtifact(options.dataDir);
      return { ...state, artifact: artifact?.manifest ?? null };
    },
    start(source: AndroidAppPrepareRequest["source"]): AndroidAppPreparation {
      if (running) return state;
      running = true;
      state = {
        status: "preparing",
        source,
        artifact: null,
        message:
          source === "github"
            ? "Checking GitHub for an Android build…"
            : "Checking local Android build tools…",
      };
      void prepare(source);
      return state;
    },
  };
}
