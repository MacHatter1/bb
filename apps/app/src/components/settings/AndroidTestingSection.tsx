import { SettingsSection } from "@/components/ui/settings-section";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { badgeVariants } from "@bb/shared-ui/badge";
import { sdk } from "@/lib/sdk";

import {
  androidAppPreparationQueryKey,
  hydrateAndroidAppPreparation,
} from "@/hooks/cache-owners/android-app-cache-owner";

export function AndroidTestingSection() {
  const client = useQueryClient();
  const download = useRef<HTMLAnchorElement>(null);
  const requested = useRef(false);
  const build = useQuery({
    queryKey: androidAppPreparationQueryKey,
    queryFn: () => sdk.system.androidAppPreparation(),
    refetchInterval: (query) =>
      query.state.data?.status === "preparing" ? 1000 : false,
  });
  const prepare = useMutation({
    mutationFn: (source: "github" | "local") =>
      sdk.system.prepareAndroidApp({ source }),
    onSuccess: (state) => {
      requested.current = true;
      hydrateAndroidAppPreparation({ queryClient: client, state });
    },
  });
  useEffect(() => {
    if (build.data?.status === "ready" && requested.current) {
      requested.current = false;
      download.current?.click();
    }
    if (build.data?.status === "failed") requested.current = false;
  }, [build.data]);
  const busy = prepare.isPending || build.data?.status === "preparing";
  const artifact = build.data?.artifact;
  const source = prepare.isPending ? prepare.variables : build.data?.source;
  return (
    <section aria-label="Android app download">
      <SettingsSection
        title={
          <span className="flex flex-wrap items-center gap-2">
            Android App
            <span className={badgeVariants({ variant: "outline" })}>
              Experimental
            </span>
          </span>
        }
        bodyClassName="space-y-3"
      >
        <p className="text-sm text-subtle-foreground">
          Download a test APK for your Android phone. The app is a work in
          progress, with a few things still missing:
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-subtle-foreground">
          <li>Push notifications are not ready yet.</li>
          <li>Updates must be downloaded and installed manually.</li>
        </ul>
        <p className="text-sm text-subtle-foreground">
          We’re working on Google Play distribution. For now, install the APK
          directly on your phone.
        </p>
        {artifact ? (
          <p className="text-sm text-subtle-foreground">
            Version {artifact.version} · Build {artifact.versionCode} ·{" "}
            {Math.ceil(artifact.size / 1024 / 1024)} MB
          </p>
        ) : null}
        <Button
          disabled={busy || build.isPending}
          onClick={() => prepare.mutate("github")}
        >
          {busy
            ? source === "local"
              ? "Building APK…"
              : "Downloading APK…"
            : "Download APK"}
        </Button>
        {build.data?.message ? (
          <p
            role={build.data.status === "failed" ? "alert" : "status"}
            className="text-sm text-subtle-foreground"
          >
            {build.data.message}
          </p>
        ) : null}
        {build.isError || prepare.isError ? (
          <p role="alert" className="text-sm text-subtle-foreground">
            Could not contact the server. Try Download APK again.
          </p>
        ) : null}
        {build.data?.status === "failed" ? (
          <div className="space-y-3">
            <p className="text-xs text-subtle-foreground">
              You can build on this server instead. It needs a configured bb
              source checkout, pnpm, Java, and the Android SDK. The first build
              can take several minutes. Local builds use a test signing key;
              switching from a release build may require reinstalling the app.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => prepare.mutate("local")}
            >
              Build on this server
            </Button>
          </div>
        ) : null}
        <a
          ref={download}
          href="/install/bb-android.apk"
          download="bb-android.apk"
          className={
            build.data?.status === "ready"
              ? "inline-block text-sm underline"
              : "hidden"
          }
        >
          Download ready APK
        </a>
        <p className="text-xs text-subtle-foreground">
          Open the APK on your Android phone and allow installation from your
          browser if prompted. Return here to download newer builds.
        </p>
      </SettingsSection>
    </section>
  );
}
