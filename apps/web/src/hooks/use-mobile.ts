import { useSyncExternalStore } from "react";

const query = "(max-width: 760px), (max-height: 500px)";
const subscribe = (listener: () => void) => {
  const media = matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
export const useIsMobile = () => useSyncExternalStore(subscribe, () => matchMedia(query).matches);
