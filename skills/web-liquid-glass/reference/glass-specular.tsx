"use client";

import * as React from "react";
import { EFFECTS_CHANGE_EVENT, LITE_CLASS } from "@/lib/perf/lite-mode";

/**
 * The moving specular highlight — the part of Liquid Glass that CSS cannot do
 * alone.
 *
 * Apple's material "picks up specular highlights as the device moves". That is
 * the whole difference between a lens and a gradient overlay: a gradient is
 * painted onto the surface, a highlight is light landing on it, and the eye
 * only believes the second one once it sees the glint respond to something.
 *
 * app/globals.css paints the sheen from two custom properties, `--lg-lx` and
 * `--lg-ly` — where the light is, in percent of the surface. They default to
 * the old hard-coded 22% / -12%, so a page with this component unmounted looks
 * exactly as it did before. This file is the only thing that ever writes them.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY SURFACE GETS ITS OWN VALUE RATHER THAN ONE GLOBAL LIGHT
 *
 * `--lg-lx` inherits, so a single write on <html> would light the whole page
 * at once and look like the cheap option. Measured, it is the expensive one:
 * an inherited custom property on the root invalidates the style of every
 * element in the document, whether or not it is glass. On a 60-surface test
 * page one root write cost 11.5ms of style recalc per frame; writing 20
 * surfaces individually cost 2.0ms, and writing 9 cost 1.1ms. The per-element
 * cost is flat in document size and linear in surfaces touched, which is the
 * curve we want — the root write's curve is the page's whole DOM.
 *
 * So both input paths, pointer and tilt, write per surface. The tilt path
 * writes the same value to each one; that is fine and still cheaper.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT KEEP IT OFF THE MAIN THREAD
 *
 *   1. ONE document-level pointer listener, not one per surface. Pointer
 *      events fire at the display's rate or faster; N listeners is N times the
 *      dispatch for the same information.
 *   2. rAF coalescing. The listener stores coordinates and nothing else — no
 *      style is written until the frame callback, so a burst of forty moves in
 *      one frame produces one write pass.
 *   3. Read-all-then-write-all. `getBoundingClientRect()` interleaved with
 *      `setProperty()` forces a style recalc per element per frame: measured
 *      at 12,000 recalcs where the batched form did 600. Rects are also cached
 *      and only re-read when something could have moved them.
 *
 * And the IntersectionObserver, which is the biggest saving of all, because on
 * a real page most glass is off screen.
 */

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */

/** Resting light position — identical to the old static gradient. */
const REST_X = 22;
const REST_Y = -12;

/**
 * How far the glint may travel, and how sharply it responds.
 *
 * `tanh` rather than a clamp, and this is the difference between the effect
 * working and not. A linear map with a clamp sends the light to 148% for any
 * surface the pointer is not near, which is far enough off the surface that
 * the highlight disappears entirely — tested, and the result was a page of
 * panels with no sheen at all except the one under the cursor. `tanh`
 * asymptotes instead: a distant surface settles with its glint pinned to the
 * edge facing the pointer, which is what a room lit from one side looks like.
 */
const AMP_X = 52; // so --lg-lx lands in roughly -2 .. 102
const GAIN_X = 1.8;

/**
 * The vertical amplitude is deliberately small — a quarter of the horizontal.
 *
 * The sheen is a 120%-wide ellipse whose centre sits ABOVE the top edge at
 * rest, so what the surface shows is the lower lip of a big soft pool. Let
 * `--lg-ly` reach the middle of the surface and the whole ellipse comes into
 * view, and it stops reading as light from above and starts reading as a
 * spotlight following the cursor. Tested at amplitudes 14, 22 and 30: 30 was a
 * blob, 22 was a blob on tall surfaces, 14 keeps the pool anchored to the top
 * lip through the whole range while still visibly rising and falling.
 */
const AMP_Y = 14;
const GAIN_Y = 1.4;

/**
 * Exponential smoothing toward the target, ~0.18 per frame (about 120ms to
 * settle). Not decoration: the pointer arrives in jumps of tens of pixels and
 * the un-eased glint snaps between them, which looks like a flicker rather
 * than a reflection. It also gives the surfaces a shared inertia, so a fast
 * sweep across the page leaves a wave rather than a step change.
 */
const EASE = 0.18;

/** Below this the write is skipped, so a settled page costs nothing. */
const EPSILON = 0.25;

/** Upright-ish in the hand. Tilt is measured against this, not against flat. */
const TILT_NEUTRAL_BETA = 55;
/** Degrees of tilt that map to the full travel. */
const TILT_SPREAD = 26;

// `.nav-capsule` holds the nav links, whose lenses inherit --lg-lx/--lg-ly
// from their nearest tracked ancestor (the glass layer is a sibling now).
const SURFACE_SELECTOR = ".lg, .nav-capsule";

/* -------------------------------------------------------------------------- */

interface Tracked {
  /** Eased, currently written. */
  x: number;
  y: number;
  /** Where it is heading. */
  tx: number;
  ty: number;
  /** Cached viewport rect. Re-read only when something could have moved it. */
  l: number;
  t: number;
  w: number;
  h: number;
}

const tanh = (v: number) => Math.tanh(v);

/**
 * Whether iOS is gating the motion sensors behind a permission call.
 *
 * Safari on iOS 13+ adds a static `requestPermission` to DeviceOrientationEvent
 * and refuses to deliver events until it has resolved `"granted"`. It MUST be
 * called from a user gesture — called on load it throws, and even where it
 * does not, prompting a visitor for motion access before they have asked for
 * anything is the kind of thing that gets a site's permission requests blocked
 * wholesale.
 */
type PermissionCapableDOE = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const orientationGate = (): PermissionCapableDOE | null => {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
    return null;
  }
  return window.DeviceOrientationEvent as PermissionCapableDOE;
};

/**
 * Ask iOS for the motion sensors. CALL THIS FROM A CLICK OR TAP HANDLER, never
 * from an effect.
 *
 * Returns true if tilt is now available — including on every platform that
 * needs no permission at all, where it resolves immediately without a prompt.
 * Safe to call more than once: once Safari has granted for this origin it
 * re-resolves silently, so a "motion effects" toggle can call it on each
 * switch-on without the visitor seeing the sheet again.
 *
 * Nothing in this file calls it. That is deliberate — see the comment on the
 * component below.
 */
export async function requestGlassTilt(): Promise<boolean> {
  const doe = orientationGate();
  if (!doe) return false;
  if (typeof doe.requestPermission !== "function") return true;
  try {
    const state = await doe.requestPermission();
    if (state === "granted") {
      window.dispatchEvent(new Event("lg-tilt-granted"));
      return true;
    }
    return false;
  } catch {
    // Throws when called outside a user gesture, and on any engine that has the
    // method but not the sensor. Neither is worth surfacing.
    return false;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Whether the light may follow the visitor at all (spec section 5): only with
 * a fine pointer (mouse or trackpad), never under reduced motion, never in the
 * lite tier. Touch devices keep the static sheen: on Android the tilt sensor
 * fires at about 60 Hz and every event restyled each glass surface, a
 * continuous repaint of the nav bar for as long as the phone was in a hand.
 */
export function specularAllowed(env: {
  finePointer: boolean;
  reducedMotion: boolean;
  lite: boolean;
}): boolean {
  return env.finePointer && !env.reducedMotion && !env.lite;
}

/**
 * Drives `--lg-lx` / `--lg-ly` on every on-screen glass surface.
 *
 * Mount once, high in the tree. Returns nothing: the hook talks to the DOM
 * directly rather than through React state, because the alternative is a
 * re-render per frame per surface, which is the thing this is trying to avoid.
 */
export function useSpecularHighlight(): void {
  React.useEffect(() => {
    // Server and any engine old enough to be missing the observers: the CSS
    // defaults already look like today's build, so doing nothing is correct.
    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined" ||
      typeof MutationObserver === "undefined"
    ) {
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    // A mouse on a desk gets the pointer path; a phone gets tilt. Attaching
    // both invites them to fight over the same two properties, and the loser
    // is whichever wrote last, which flickers.
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

    /** Every `.lg` currently under observation. */
    let observed = new Set<Element>();
    /** The subset on screen — the only ones ever written to. */
    const visible = new Set<HTMLElement>();
    const tracked = new WeakMap<HTMLElement, Tracked>();

    /**
     * What is driving the light right now.
     *
     * `rest` is its own mode rather than a flag, because "the pointer left the
     * window" and "there is no pointer" need different behaviour: the first
     * has to keep the frame loop running until every glint has eased back to
     * 22 / -12, the second must not start it at all.
     */
    let mode: "idle" | "pointer" | "tilt" | "rest" = "idle";

    let pointerX = 0;
    let pointerY = 0;

    let tiltX = REST_X;
    let tiltY = REST_Y;

    let frame = 0;
    let needsMeasure = true;
    let rescan = 0;
    let running = true;

    const clear = (el: HTMLElement) => {
      el.style.removeProperty("--lg-lx");
      el.style.removeProperty("--lg-ly");
      tracked.delete(el);
    };

    const schedule = () => {
      if (!frame && running && mode !== "idle" && !reduced.matches) {
        frame = requestAnimationFrame(tick);
      }
    };

    /* ---------------------------------------------------------------- */
    /* The frame                                                         */

    function tick() {
      frame = 0;
      if (!running || reduced.matches || mode === "idle") return;

      const list = Array.from(visible);
      if (list.length === 0) return;

      // READ PHASE. Every rect first. Nothing below this block may touch the
      // DOM's geometry, or each write invalidates the next read and the frame
      // turns into N layouts instead of one.
      if (needsMeasure) {
        for (const el of list) {
          const r = el.getBoundingClientRect();
          let s = tracked.get(el);
          if (!s) {
            s = { x: REST_X, y: REST_Y, tx: REST_X, ty: REST_Y, l: 0, t: 0, w: 1, h: 1 };
            tracked.set(el, s);
          }
          s.l = r.left;
          s.t = r.top;
          s.w = r.width || 1;
          s.h = r.height || 1;
        }
        needsMeasure = false;
      }

      // WRITE PHASE.
      let settled = true;
      for (const el of list) {
        const s = tracked.get(el);
        if (!s) continue;

        if (mode === "pointer") {
          // The pointer is a light source in VIEWPORT space, not a cursor the
          // highlight follows. Each surface asks where that light is relative
          // to its own box, which is why two panels side by side glint on
          // opposite edges instead of moving in lockstep.
          s.tx = 50 + AMP_X * tanh(((pointerX - s.l) / s.w - 0.5) * GAIN_X);
          s.ty = REST_Y + AMP_Y * tanh(((pointerY - s.t) / s.h - 0.5) * GAIN_Y);
        } else if (mode === "tilt") {
          s.tx = tiltX;
          s.ty = tiltY;
        } else {
          s.tx = REST_X;
          s.ty = REST_Y;
        }

        const nx = s.x + (s.tx - s.x) * EASE;
        const ny = s.y + (s.ty - s.y) * EASE;
        if (Math.abs(nx - s.x) > EPSILON || Math.abs(ny - s.y) > EPSILON) settled = false;
        s.x = nx;
        s.y = ny;
        el.style.setProperty("--lg-lx", nx.toFixed(1));
        el.style.setProperty("--lg-ly", ny.toFixed(1));
      }

      // The loop stops the moment the glints reach their targets. A page with
      // a still pointer costs nothing at all.
      if (settled && mode === "rest") mode = "idle";
      else if (!settled) schedule();
    }

    /* ---------------------------------------------------------------- */
    /* Which surfaces are live                                           */

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            visible.add(el);
          } else if (visible.delete(el)) {
            // Leave it at the CSS default rather than frozen mid-travel, so it
            // is correct the instant it scrolls back in.
            clear(el);
          }
        }
        needsMeasure = true;
        schedule();
      },
      // A little margin, so a surface is already tracking by the time its top
      // edge appears rather than snapping into place on screen.
      { rootMargin: "15%" },
    );

    const scan = () => {
      rescan = 0;
      const found = document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR);
      const next = new Set<Element>();
      for (const el of found) {
        next.add(el);
        if (!observed.has(el)) io.observe(el);
      }
      for (const el of observed) {
        if (!next.has(el)) {
          io.unobserve(el);
          visible.delete(el as HTMLElement);
        }
      }
      observed = next;
    };

    // App Router navigations replace the whole subtree, so the set of glass
    // surfaces changes without this effect re-running. Coalesced to one rescan
    // per frame — React commits arrive in bursts and querySelectorAll on every
    // mutation record would be the most expensive thing in the file.
    const mo = new MutationObserver(() => {
      if (!rescan) rescan = requestAnimationFrame(scan);
    });

    /* ---------------------------------------------------------------- */
    /* Inputs                                                            */

    const onPointerMove = (e: PointerEvent) => {
      // Touch produces a pointermove on every tap and drag, which would light
      // the surface under the finger and then leave it lit. Tilt is the
      // touch device's input.
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      // A switch to lite mid-visit: do nothing until the effects-change event
      // detaches this listener.
      if (document.documentElement.classList.contains(LITE_CLASS)) return;
      pointerX = e.clientX;
      pointerY = e.clientY;
      mode = "pointer";
      schedule();
    };

    const onPointerLeave = (e: PointerEvent) => {
      // Pointer out of the WINDOW, not merely off one element — a null
      // relatedTarget is the only signal for that. Ease every surface back to
      // rest rather than leaving the light stuck wherever the cursor exited.
      if (e.relatedTarget) return;
      mode = "rest";
      schedule();
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null && e.gamma === null) return;
      mode = "tilt";
      tiltX = 50 + AMP_X * tanh((e.gamma ?? 0) / TILT_SPREAD);
      tiltY = REST_Y + AMP_Y * tanh(((e.beta ?? TILT_NEUTRAL_BETA) - TILT_NEUTRAL_BETA) / TILT_SPREAD);
      schedule();
    };

    // Rect cache invalidation. Scroll and resize are the obvious ones; the
    // mutation observer covers layout shifts from content arriving.
    const invalidate = () => {
      needsMeasure = true;
      schedule();
    };

    /* ---------------------------------------------------------------- */
    /* Attach                                                            */

    let tiltAttached = false;

    const attachTilt = () => {
      // No permission call here, ever. On iOS this listener simply receives
      // nothing until something else has been granted permission from a user
      // gesture, at which point events start arriving and the highlight comes
      // to life with no further work. On Android and desktop there is no gate
      // and events arrive immediately.
      if (tiltAttached || !orientationGate()) return;
      window.addEventListener("deviceorientation", onOrientation, { passive: true });
      tiltAttached = true;
    };

    const attach = () => {
      // The tilt branch below is unreachable while this gate holds; it stays
      // for a better-funded tier rather than being deleted.
      if (
        !specularAllowed({
          finePointer: finePointer.matches,
          reducedMotion: reduced.matches,
          lite: document.documentElement.classList.contains(LITE_CLASS),
        })
      ) {
        return;
      }
      if (finePointer.matches) {
        document.addEventListener("pointermove", onPointerMove, { passive: true });
        document.addEventListener("pointerout", onPointerLeave, { passive: true });
      } else {
        attachTilt();
        window.addEventListener("lg-tilt-granted", attachTilt);
      }
      window.addEventListener("scroll", invalidate, { passive: true, capture: true });
      window.addEventListener("resize", invalidate, { passive: true });
      mo.observe(document.body, { childList: true, subtree: true });
      scan();
    };

    const detach = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerLeave);
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("lg-tilt-granted", attachTilt);
      window.removeEventListener("scroll", invalidate, { capture: true });
      window.removeEventListener("resize", invalidate);
      tiltAttached = false;
      mo.disconnect();
      if (rescan) cancelAnimationFrame(rescan);
      if (frame) cancelAnimationFrame(frame);
      rescan = 0;
      frame = 0;
      for (const el of visible) clear(el);
      for (const el of observed) io.unobserve(el);
      observed = new Set();
      visible.clear();
      mode = "idle";
    };

    // Reduced motion is honoured live, not only at mount. Someone turning it on
    // in System Settings while the page is open gets the static sheen back
    // immediately, with the inline properties removed so the CSS default
    // resumes — not merely a frozen last frame.
    const onPreferenceChange = () => {
      detach();
      running = !reduced.matches;
      if (running) attach();
    };

    running = !reduced.matches;
    if (running) attach();

    reduced.addEventListener("change", onPreferenceChange);
    finePointer.addEventListener("change", onPreferenceChange);
    // The frame-time probe can switch a page to lite mid-visit.
    window.addEventListener(EFFECTS_CHANGE_EVENT, onPreferenceChange);

    return () => {
      window.removeEventListener(EFFECTS_CHANGE_EVENT, onPreferenceChange);
      running = false;
      reduced.removeEventListener("change", onPreferenceChange);
      finePointer.removeEventListener("change", onPreferenceChange);
      detach();
      io.disconnect();
    };
  }, []);
}

/**
 * Renders nothing; exists so the hook can be mounted from a server layout.
 *
 * Put it next to `<GlassFilters />` in app/(public)/layout.tsx. One instance
 * per page — a second would double every style write for no visual change.
 *
 * It does NOT ask for motion permission. On iOS the tilt highlight stays
 * inert until something calls `requestGlassTilt()` from a real tap, which is a
 * decision for a visible control (a "motion effects" switch in a preferences
 * sheet, say) and not for a decoration that mounts on every page. A permission
 * sheet that appears unprompted on page load is worse than a static gradient.
 */
export function GlassSpecular(): null {
  useSpecularHighlight();
  return null;
}
