import { useState } from "react";

/**
 * True once the element has entered the viewport, and from then on, so work started for it
 * (such as a hover preview's fetch) is not cancelled when it scrolls back out.
 */
export function useSeenInViewport(): readonly [(element: Element | null) => void, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const ref = (element: Element | null) => {
    if (seen || element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  };
  return [ref, seen] as const;
}
