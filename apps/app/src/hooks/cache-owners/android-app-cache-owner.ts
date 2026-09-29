import type { AndroidAppPreparation } from "@bb/server-contract";
import type { QueryClientArg } from "../cache-effect-types";

export const androidAppPreparationQueryKey = [
  "system",
  "android-app-preparation",
];

export function hydrateAndroidAppPreparation({
  queryClient,
  state,
}: QueryClientArg & { state: AndroidAppPreparation }): void {
  queryClient.setQueryData(androidAppPreparationQueryKey, state);
}
