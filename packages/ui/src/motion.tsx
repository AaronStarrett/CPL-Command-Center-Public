"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

export type MotionPreference = "system" | "full" | "reduced";
export type MotionProfile = "full" | "reduced";

interface MotionContextValue {
  readonly preference: MotionPreference;
  readonly profile: MotionProfile;
  readonly pageVisible: boolean;
  readonly ready: boolean;
  readonly setPreference: (preference: MotionPreference) => void;
}

const MOTION_STORAGE_KEY = "bea:motion-profile:v1";
const AMBIENT_SURFACE_SELECTOR = ".bea-floating-surface";
const AMBIENT_ANIMATION_NAME = "bea-surface-float";
const MOTION_LOAD_SELECTOR =
  '.bea-button[aria-busy="true"], [data-motion-load-source][aria-busy="true"]';
const MotionContext = createContext<MotionContextValue | null>(null);

function storedPreference(): MotionPreference {
  const value = window.localStorage.getItem(MOTION_STORAGE_KEY);
  return value === "full" || value === "reduced" || value === "system" ? value : "system";
}

function resolvedProfile(preference: MotionPreference, systemReduced: boolean): MotionProfile {
  if (preference === "reduced") return "reduced";
  if (preference === "full") return "full";
  return systemReduced ? "reduced" : "full";
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<MotionPreference>("system");
  const [systemReduced, setSystemReduced] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const profile = resolvedProfile(preference, systemReduced);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPreferenceChange = () => setSystemReduced(media.matches);
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");

    setPreferenceState(storedPreference());
    onPreferenceChange();
    onVisibilityChange();
    setInitialized(true);
    media.addEventListener("change", onPreferenceChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      media.removeEventListener("change", onPreferenceChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    document.documentElement.dataset.motionPreference = preference;
    document.documentElement.dataset.motionProfile = profile;
    document.documentElement.dataset.motionReady = "true";
    document.documentElement.dataset.motionVisibility = pageVisible ? "visible" : "hidden";
  }, [initialized, pageVisible, preference, profile]);

  useEffect(() => {
    const observed = new Set<Element>();

    function setAmbientPlaybackRate(element: Element, inView: boolean) {
      if (typeof element.getAnimations !== "function") return;
      for (const animation of element.getAnimations({ subtree: true })) {
        const animationName = (animation as Animation & { readonly animationName?: string })
          .animationName;
        if (animationName === AMBIENT_ANIMATION_NAME) animation.updatePlaybackRate(inView ? 1 : 0);
      }
    }

    const intersection =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                setAmbientPlaybackRate(entry.target, entry.isIntersecting);
            },
            { rootMargin: "120px 0px", threshold: 0.01 },
          );

    function observeSurface(element: Element) {
      if (observed.has(element)) return;
      observed.add(element);
      intersection?.observe(element);
    }

    function discoverSurfaces(root: ParentNode) {
      if (root instanceof Element && root.matches(AMBIENT_SURFACE_SELECTOR)) observeSurface(root);
      for (const element of root.querySelectorAll(AMBIENT_SURFACE_SELECTOR))
        observeSurface(element);
    }

    function releaseSurfaces(root: ParentNode) {
      const matches = [
        ...(root instanceof Element && root.matches(AMBIENT_SURFACE_SELECTOR) ? [root] : []),
        ...root.querySelectorAll(AMBIENT_SURFACE_SELECTOR),
      ];
      for (const element of matches) {
        setAmbientPlaybackRate(element, true);
        intersection?.unobserve(element);
        observed.delete(element);
      }
    }

    function syncModalState() {
      document.documentElement.dataset.motionModal = document.querySelector(
        "dialog.bea-dialog[open]",
      )
        ? "open"
        : "closed";
    }

    function syncLoadState() {
      document.documentElement.dataset.motionLoad = document.querySelector(MOTION_LOAD_SELECTOR)
        ? "busy"
        : "idle";
    }

    discoverSurfaces(document);
    syncModalState();
    syncLoadState();
    const mutation = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) discoverSurfaces(node);
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element) releaseSurfaces(node);
        }
      }
      syncModalState();
      syncLoadState();
    });
    mutation.observe(document.body, {
      attributeFilter: ["aria-busy", "open"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    return () => {
      mutation.disconnect();
      intersection?.disconnect();
      for (const element of observed) setAmbientPlaybackRate(element, true);
      observed.clear();
      document.documentElement.dataset.motionModal = "closed";
      document.documentElement.dataset.motionLoad = "idle";
    };
  }, []);

  function setPreference(nextPreference: MotionPreference) {
    setPreferenceState(nextPreference);
    window.localStorage.setItem(MOTION_STORAGE_KEY, nextPreference);
  }

  const value = useMemo<MotionContextValue>(
    () => ({ pageVisible, preference, profile, ready: initialized, setPreference }),
    [initialized, pageVisible, preference, profile],
  );

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotionPreferences(): MotionContextValue {
  const value = useContext(MotionContext);
  if (!value) {
    return {
      pageVisible: true,
      preference: "system",
      profile: "full",
      ready: false,
      setPreference: () => undefined,
    };
  }
  return value;
}

export function MotionPreferenceControl() {
  const { preference, profile, ready, setPreference } = useMotionPreferences();

  function changePreference(event: ChangeEvent<HTMLSelectElement>) {
    setPreference(event.target.value as MotionPreference);
  }

  return (
    <div className="bea-motion-preference">
      <label htmlFor="bea-motion-preference">Motion</label>
      <select
        id="bea-motion-preference"
        value={preference}
        disabled={!ready}
        data-hydration-ready={ready}
        onChange={changePreference}
      >
        <option value="system">Use device preference</option>
        <option value="full">Full Motion</option>
        <option value="reduced">Reduced Motion</option>
      </select>
      <span role="status">Active: {profile === "full" ? "Full Motion" : "Reduced Motion"}</span>
    </div>
  );
}
