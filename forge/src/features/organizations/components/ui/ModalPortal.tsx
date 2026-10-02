"use client";

import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";

/**
 * No subscription is needed: the store is a one-way latch that flips from "server"
 * to "client" once, at hydration. An empty subscribe is correct - there is no
 * event to listen for - and the value comes from getSnapshot.
 */
const subscribeToHydration = () => () => {};
const getIsHydrated = () => true;
const getIsServer = () => false;

/**
 * Renders children into document.body, but only after hydration.
 *
 * createPortal cannot run on the server - there is no document - so the first
 * client render has to produce the same empty output the server did, or React
 * reports a hydration mismatch and discards the server markup.
 *
 * This used to be a `mounted` state flag flipped in a mount effect, which
 * react-hooks/set-state-in-effect flags for good reason: it schedules a second
 * render pass purely to discover whether rendering is safe yet.
 *
 * useSyncExternalStore is the supported way to ask the question. React calls
 * getServerSnapshot during server rendering *and* during hydration, so both
 * produce false and the markup matches; the first render after hydration calls
 * getSnapshot, gets true, and portals in that same pass. No effect, no extra
 * commit, and the portal cannot appear before hydration has settled.
 */
export function ModalPortal({ children }: { children: React.ReactNode }) {
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getIsHydrated,
    getIsServer,
  );

  if (!isHydrated) return null;

  return createPortal(children, document.body);
}