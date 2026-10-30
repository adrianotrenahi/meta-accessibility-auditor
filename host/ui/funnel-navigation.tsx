import { useMemo, useSyncExternalStore } from "react";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  return () => window.removeEventListener("popstate", fn);
};
export function navigate(href: string, replace = false) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin)
    throw Error("This offline proof cannot open another service.");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
const router = {
  push: (href: string) => navigate(href),
  replace: (href: string) => navigate(href, true),
  refresh: () => window.dispatchEvent(new PopStateEvent("popstate")),
  back: () => window.history.back(),
  prefetch: () => Promise.resolve(),
};
export const useRouter = () => router;
export const useProofLocation = () =>
  useSyncExternalStore(
    subscribe,
    () => window.location.href,
    () => "http://offline/",
  );
export const usePathname = () => new URL(useProofLocation()).pathname;
export function useSearchParams() {
  const href = useProofLocation();
  return useMemo(() => new URLSearchParams(new URL(href).search), [href]);
}
export function useParams() {
  const href = useProofLocation();
  return useMemo(
    () => ({
      id: new URL(href).pathname.split("/").at(-1),
      jobId: new URL(href).pathname.split("/").at(-1),
    }),
    [href],
  );
}
