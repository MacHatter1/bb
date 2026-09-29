import { spawn } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

export async function buildAndroidAppLocally(
  dataDir: string,
  progress: (message: string) => void,
) {
  const source = process.env.BB_ANDROID_SOURCE_DIR;
  if (!source)
    throw new Error(
      "Local building needs a bb source checkout. Set BB_ANDROID_SOURCE_DIR on this server, install its pnpm dependencies and Android build tools, then retry.",
    );
  if (process.platform === "win32")
    throw new Error(
      "Local Android builds currently require a macOS or Linux server. Use the GitHub APK on Windows.",
    );
  const buildScript = join(
    source,
    "apps/mobile/scripts/build-android-local.sh",
  );
  const publishScript = join(
    source,
    "apps/mobile/scripts/publish-android-apk.mjs",
  );
  for (const path of [
    buildScript,
    publishScript,
    join(source, "node_modules"),
  ]) {
    if (!(await stat(path).catch(() => null)))
      throw new Error(
        "BB_ANDROID_SOURCE_DIR must contain a bb source checkout with mobile build scripts and installed pnpm dependencies. Run pnpm install in that checkout.",
      );
  }
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk || !(await stat(join(sdk, "build-tools")).catch(() => null)))
    throw new Error(
      "Android SDK build-tools are missing. Set ANDROID_HOME or ANDROID_SDK_ROOT on the server to an installed Android SDK, then retry.",
    );
  await mkdir(join(dataDir, "android-testing"), { recursive: true });
  const log = await open(join(dataDir, "android-testing/build.log"), "w");
  function run(
    command: string,
    args: string[],
    missing: string,
    timeout: number,
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: source,
        env: {
          ...process.env,
          NODE_ENV: "production",
          EXPO_PUBLIC_BB_E2E: "0",
          CI: "1",
        },
        stdio: ["ignore", log.fd, log.fd],
        detached: true,
      });
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        reject(
          new Error(
            "The Android build timed out. Check android-testing/build.log in the server data directory.",
          ),
        );
      }, timeout);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error(missing));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(missing));
      });
    });
  }
  try {
    await run(
      "pnpm",
      ["--version"],
      "pnpm is missing or not runnable on this server. Install pnpm and make it available to the bb server process.",
      10_000,
    );
    await run(
      "java",
      ["-version"],
      "Java is missing or not runnable on this server. Install JDK 17 or newer and configure JAVA_HOME/PATH for the bb server process.",
      10_000,
    );
    progress(
      "Building Android APK on this server. This can take several minutes…",
    );
    await run(
      "bash",
      [buildScript, "arm64-v8a"],
      "Android build failed. Check android-testing/build.log in the server data directory for Gradle, Java, or SDK errors.",
      30 * 60_000,
    );
    progress("Verifying and publishing the local APK…");
    await run(
      process.execPath,
      [
        publishScript,
        join(source, "apps/mobile/build-output/bb-android-local.apk"),
        dataDir,
      ],
      "The local APK could not be verified or published. Check android-testing/build.log in the server data directory.",
      60_000,
    );
  } finally {
    await log.close();
  }
}
