"use client";
import * as React from "react";
import { cn } from "@/lib/utilities/cn";
import { LITE_CLASS } from "@/lib/perf/lite-mode";

/**
 * Liquid Glass surfaces. The material itself lives in app/globals.css —
 * this file is the typed way to ask for it, plus the two things CSS cannot do
 * on its own: the SVG refraction filter, and the runtime test that decides
 * whether this browser may use it.
 *
 * Glass goes on the NAVIGATION layer — bars, controls, floating chrome — not on
 * body content. See the header comment in app/globals.css for why.
 */

type GlassVariant =
  /** The default material: tinted, blurred, rimmed, floating. */
  | "regular"
  /** Over photography or video. Barely tinted; ships its own dimming scrim. */
  | "clear"
  /** `fixed` chrome that re-blurs on every scroll frame. Cheaper, top rim only. */
  | "bar";

export interface GlassProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: GlassVariant;
  /** Renders the press/hover response. For anything the visitor can operate. */
  interactive?: boolean;
  /**
   * Opt into SVG refraction. Silently inert unless the browser passed the
   * runtime test — so it is safe to set on anything, and worth setting only on
   * large surfaces over busy backdrops, where the ripple is actually visible.
   */
  refract?: boolean;
  /**
   * The surface sits over a dark photograph rather than over the page. Switches
   * the tint to the on-media palette in both themes.
   */
  onMedia?: boolean;
  /** Render as a different element — `header`, `nav`, `aside`. */
  as?: React.ElementType;
}

export const glassClass = ({
  variant = "regular",
  interactive = false,
  refract = false,
  onMedia = false,
}: Pick<GlassProps, "variant" | "interactive" | "refract" | "onMedia"> = {}) =>
  cn(
    "lg",
    variant === "clear" && "lg-clear",
    variant === "bar" && "lg-bar",
    interactive && "lg-interactive",
    refract && "lg-refract",
    onMedia && "lg-on-media",
  );

export const Glass = React.forwardRef<HTMLDivElement, GlassProps>(
  (
    {
      className,
      variant = "regular",
      interactive,
      refract,
      onMedia,
      as: Comp = "div",
      ...props
    },
    ref,
  ) => (
    <Comp
      ref={ref}
      className={cn(
        glassClass({ variant, interactive, refract, onMedia }),
        className,
      )}
      {...props}
    />
  ),
);
Glass.displayName = "Glass";

/* -------------------------------------------------------------------------- */

/**
 * The refraction filter, plus the capability probe that enables it.
 *
 * Mount once, high in the tree. It renders a zero-size SVG carrying the filter
 * definition, and sets `data-lg-refract="on"` on <html> only if this browser
 * genuinely honours an SVG filter inside `backdrop-filter`.
 *
 * WHY THE PROBE IS NOT JUST `@supports`
 *
 * `CSS.supports("backdrop-filter", "url(#x)")` returns true in engines that
 * then ignore the reference — the property parses, the filter never runs. The
 * surface is still glass in that case (blur and saturate are applied normally),
 * so a false positive is cosmetic rather than broken, but it means one engine
 * gets a ripple and another silently does not while both claim support. The
 * Chromium check makes that explicit rather than accidental.
 *
 * This is deliberate user-agent sniffing, which is normally the wrong tool. It
 * is the right one here: the thing being detected is a rendering behaviour with
 * no feature-detectable signal, and the consequence of guessing wrong in either
 * direction is a decoration appearing or not appearing.
 */
export function GlassFilters() {
  React.useEffect(() => {
    const root = document.documentElement;
    // The lite tier has no backdrop to refract (spec section 5).
    if (root.classList.contains(LITE_CLASS)) return;

    const parses =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      (CSS.supports("backdrop-filter", 'blur(1px) url("#lg-edge-lens")') ||
        CSS.supports(
          "-webkit-backdrop-filter",
          'blur(1px) url("#lg-edge-lens")',
        ));

    // `userAgentData` is Chromium-only and reports Safari as absent entirely,
    // which is exactly the distinction needed. The UA-string fallback covers
    // older Chromium and anything running without the hints API.
    const ua = navigator.userAgent;
    const chromium =
      (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
        .userAgentData?.brands.some((b) => /Chromium/i.test(b.brand)) ??
      (/Chrome|Chromium|Edg/i.test(ua) && !/OPR|Safari\/[0-9.]+$/i.test(ua));

    if (parses && chromium) root.setAttribute("data-lg-refract", "on");
    return () => root.removeAttribute("data-lg-refract");
  }, []);

  return (
    <svg
      aria-hidden
      focusable="false"
      // Not `display: none` and not `width={0}`: a filter inside a fully hidden
      // SVG is skipped by the compositor in some Chromium builds, and the
      // surfaces referencing it fall back to an unfiltered backdrop. A 0-opacity
      // absolutely-positioned 1px square is always live and never visible.
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <defs>
        {/*
          EDGE LENS — the refraction, built without a single image.

          A real lens leaves its centre alone and bends hardest at the rim.
          Uniform turbulence (the obvious first attempt, and what this filter
          replaced) bends everywhere equally, which reads as hand-poured
          bottle glass rather than as an Apple control.

          How this produces a lens out of nothing:

            feFlood fills the FILTER REGION — which is exactly the element's
            border box — with opaque white. Blurring that gives a scalar field
            that is 1.0 through the middle and ramps to 0 across a band at
            every edge whose width is set by stdDeviation, in CSS pixels. The
            DERIVATIVE of that field is zero in the centre and peaks at the
            rim, which is precisely the displacement a lens applies. Two
            offset copies differenced give the signed x-gradient, two more
            give y, and those become the red and green channels of a
            displacement map where 0.5 means "do not move this pixel".

          Because stdDeviation is in pixels, the rim is the same physical
          width on a 620px panel and a 120px button — no per-size tuning. It
          degrades gracefully below ~40px in an axis, where the two opposing
          ramps overlap and the bend simply gets softer.

          Three things here are load-bearing and look like noise:

            colorInterpolationFilters="sRGB" — without it the 0.5 constants are
            applied in linear space, come back as ~188/255, and the neutral
            point shifts: the whole surface slides diagonally by ~6px instead
            of only its edges moving.

            The filter region is 0/0/100%/100%, NOT the -20%/140% a filter
            normally wants. feFlood fills the region, so enlarging it moves the
            mask edge off the element and there is no bend left inside it.

            The detour through feColorMatrix to pack each tap into its own
            channel. Differencing the two blurred floods directly with
            feComposite arithmetic fails, because arithmetic works on
            PREMULTIPLIED values and applies the same k values to alpha —
            alpha comes out 0.5 and un-premultiplying blows the result to
            near-white. feColorMatrix operates non-premultiplied and can pin
            alpha to 1.
        */}
        <filter
          id="lg-edge-lens"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          {/* stdDeviation sets the rim width in CSS px. */}
          <feFlood floodColor="#ffffff" floodOpacity="1" result="box" />
          <feGaussianBlur in="box" stdDeviation="16" result="soft" />

          {/* Central-difference taps: dx = soft(x-8) - soft(x+8), same for y. */}
          <feOffset in="soft" dx="8" dy="0" result="oL" />
          <feOffset in="soft" dx="-8" dy="0" result="oR" />
          <feOffset in="soft" dx="0" dy="8" result="oT" />
          <feOffset in="soft" dx="0" dy="-8" result="oB" />

          <feColorMatrix
            in="oL"
            type="matrix"
            result="cL"
            values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
          />
          <feColorMatrix
            in="oR"
            type="matrix"
            result="cR"
            values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1"
          />
          <feComposite
            in="cL"
            in2="cR"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="px"
          />
          {/*
            The 1.2 is the gain. Peak map deviation is
            gain x 0.798 x tap / stdDeviation = 0.48 — deliberately just under
            0.5. Past that the map clips, the rim plateaus, and the bend stops
            being a curve and becomes a hard translated band.
          */}
          <feColorMatrix
            in="px"
            type="matrix"
            result="dx"
            values="1.2 -1.2 0 0 0.5  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
          />

          <feColorMatrix
            in="oT"
            type="matrix"
            result="cT"
            values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
          />
          <feColorMatrix
            in="oB"
            type="matrix"
            result="cB"
            values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1"
          />
          <feComposite
            in="cT"
            in2="cB"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="py"
          />
          <feColorMatrix
            in="py"
            type="matrix"
            result="dy"
            values="0 0 0 0 0  1.2 -1.2 0 0 0.5  0 0 0 0 0  0 0 0 0 1"
          />

          {/* R = x displacement, G = y displacement, 0.5 = stay put. */}
          <feComposite
            in="dx"
            in2="dy"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="lensMap"
          />

          {/*
            scale 24 means a maximum movement of 12px, reached only at the rim.
            The ceiling is about 32 before the rim band stops being
            recognisable as whatever it is made of — and what is behind this
            glass is often prayer times, so this stays conservative.
          */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="lensMap"
            scale={24}
            xChannelSelector="R"
            yChannelSelector="G"
            result="bent"
          />
          {/* Backfill whatever the displacement sampled from outside the box. */}
          <feComposite in="bent" in2="SourceGraphic" operator="over" />
        </filter>
      </defs>
    </svg>
  );
}
