---
name: web-liquid-glass
description: Build Apple-style Liquid Glass surfaces on the web (CSS + React/Next.js + Tailwind) that read as real glass rather than a blurry box. Use when adding glass, glassmorphism, frosted or translucent nav bars, capsule navs, glass cards, panels, chips, segmented controls or lens buttons to a website, when tuning glass to look like iOS 26/27, or when debugging glass glitches such as double borders, murky nested glass, scroll jank, glass overriding Tailwind utilities, or Safari rendering less than Chrome.
---

# Web Liquid Glass

A production glass material for websites, extracted from a live Next.js + Tailwind site. The full working source is in `reference/`:

- `reference/liquid-glass.css`: the whole material (tokens, surface, variants, shaped glass, refraction, degradation). About 2,200 lines with long comments explaining every value. Read the section you need rather than the whole file.
- `reference/glass.tsx`: the `<Glass>` React component and the SVG refraction filter.
- `reference/glass-specular.tsx`: the pointer- and tilt-tracked specular highlight.

The reference imports two site helpers (`cn` and `LITE_CLASS` from a lite-mode module). Swap in the project's own `cn`/`clsx`, and a class name for "effects off". Rules named `sky-*`, `kiosk-*` and prayer-related selectors are site-specific examples of variants. Drop them or use them as patterns.

## What glass is

Glass has four parts. A web version looks cheap when it ships only the first:

1. **Material**: blur AND a saturation boost (about 200%). Below ~150% it reads as grey plastic. Add brightness lift and contrast pull so busy content behind it diffuses to a soft wash.
2. **Rim**: a bright hairline where light catches the edge, dimmer on the opposite edge. Blur without a rim never reads as glass.
3. **Sheen**: a soft specular highlight inside the top edge.
4. **Depth**: a wide, very soft, low-opacity shadow, not a tight card shadow.

Refraction (content bending at the edge) is a fifth part, and the only one the web can't do cheaply. It needs `backdrop-filter: url(#svg-filter)`, which works in Chromium only.

## Where glass goes

Put glass on the navigation layer (bars, capsule navs, floating controls, sheets), not on body content. Text contrast on glass depends on whatever scrolls behind it, so it can't be guaranteed. Keep opaque cards the default for content and make glass opt-in per surface (`.lg`).

## Rules that cost real time

1. **Glass CSS must live in the same file as `@tailwind base`, inside `@layer`.** Tailwind resolves `@layer` per file, so a separate CSS file errors on `@layer base`. Dropping the wrapper makes the rules unlayered, and unlayered rules beat every Tailwind utility. `.lg { position: relative }` then silently overrides `fixed` on a nav.
2. **Never write `--x: calc(var(--x) * 0.7)`.** It's a cycle: invalid at computed-value time, it silently falls back to the inherited value with no error. Use a second variable (`--lg-clarity-bump`, `--lg-press`).
3. **A glass surface has exactly one edge, and `::before` draws it.** Two edges (a `::before` rim plus inset `box-shadow` bevels, or a spread shadow outside the border box) give a "double border" that no amount of alpha tuning fixes.
4. **`corner-shape` is not inherited.** With `corner-shape: squircle` on the surface, every pseudo-element drawing on the boundary needs BOTH `border-radius: inherit` and `corner-shape: inherit`, or the rim follows a different curve from the body.
5. **No `backdrop-filter` on glass nested inside glass.** It samples an already-tinted backdrop and goes murky. A selection chip inside a glass bar (`.lg-chip`) is a tinted lens with no blur of its own.
6. **Don't animate an inherited custom property on `:root`.** It invalidates the whole document's style: about 11.6 ms per frame on a 60-surface page, against 2 ms writing the same value per element.
7. **Bars re-blur on every scroll frame.** Give `.lg-bar` a smaller blur radius plus `contain: paint`. If a device still janks, set `--lg-blur-bar: 0px`; the rim and sheen carry most of the look.
8. **Don't flatten frosted glass to fix a glitch.** A near-opaque "solid colour" bar loses the look. Find the geometric cause instead (masks thinning the body at the edge, a doubled rim).
9. **An SVG refraction lens must never sample past its own box.** Chrome returns transparent there and the original content shows through as ghosts.

## Safari and iPhone

WebKit supports `backdrop-filter` but rejects SVG filters inside it, so Safari gets less than Chrome: no refraction, ever. What Safari can refract is its own toolbar. Set `viewportFit: "cover"` so the page runs under it, then `env(safe-area-inset-*)` becomes mandatory on the nav and footer.

## Accessibility and fallbacks (always ship these)

Every surface must degrade to a near-opaque tint that looks close and costs nothing per frame:

- `@media (prefers-reduced-transparency: reduce)`
- `@supports not (backdrop-filter: blur(1px))`
- `@media (prefers-contrast: more)`: a stronger tint and a solid edge
- a root class such as `.lg-off` that kills every glass surface at once (for a user toggle or a low-power mode)

Give bars their own, higher maximum tint (`--lg-tint-max-bar`) so nav links keep text contrast when content scrolls under them.

## How to apply

1. Copy the token block and the surface section from `reference/liquid-glass.css` into the project's main CSS file, inside its existing `@layer` blocks (rule 1).
2. Map the colour tokens to the project's palette. The reference uses shadcn-style `hsl(var(--card))` tokens.
3. Use `<Glass>` from `reference/glass.tsx` or plain `.lg`, `.lg-bar`, `.lg-nav`, `.lg-pane`, `.lg-chip` and `.lg-refract` classes.
4. Add the specular highlight from `reference/glass-specular.tsx` only where it earns its cost (hero controls, the main nav), and respect `prefers-reduced-motion`.
5. Check in Chrome AND Safari, in light AND dark, over a busy photo and over plain text.
