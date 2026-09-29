// oxlint-disable-next-line no-restricted-imports
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { androidAppArtifactSchema } from "@bb/server-contract";

export async function readAndroidAppArtifact(dataDir: string) {
  try {
    const manifest = androidAppArtifactSchema.parse(
      JSON.parse(
        await readFile(join(dataDir, "android-testing", "latest.json"), "utf8"),
      ),
    );
    const path = join(dataDir, "android-testing", `${manifest.sha256}.apk`);
    const file = await stat(path);
    if (!file.isFile() || file.size !== manifest.size) return null;
    return { manifest, path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function androidApkResponse(dataDir: string, request: Request) {
  const artifact = await readAndroidAppArtifact(dataDir);
  if (artifact === null)
    return new Response("No Android build is available.", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  const etag = `"sha256-${artifact.manifest.sha256}"`;
  const headers = {
    "cache-control": "private, no-cache",
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": 'attachment; filename="bb-android.apk"',
    "x-bb-artifact-sha256": artifact.manifest.sha256,
    etag,
  };
  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });
  const file = await open(artifact.path, "r");
  return new Response(
    Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>,
    {
      headers: { ...headers, "content-length": String(artifact.manifest.size) },
    },
  );
}
