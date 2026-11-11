# Logo and wordmark

- `logo.svg`: a fat, rounded-square white C in a black circle, its left side broken by the
  green dot. The source; also
  the favicon for browsers that take SVG (`<link rel="icon" href="/logo.svg" type="image/svg+xml">`).
- `favicon.ico` (16, 32, 48), `apple-touch-icon.png` (180), `logo-512.png`: rendered from it.

The wordmark is text, not an image: `candor` in lowercase,
white, in the system sans-serif (Tailwind's `font-sans`), semibold, tight tracking, then a small
green dot.

```html
<h1 class="text-4xl font-semibold tracking-tight text-white">
  candor<span class="ml-2 inline-block size-2.5 rounded-full bg-emerald-400"></span>
</h1>
```

Without Tailwind: `font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 600;
letter-spacing: -0.025em`, the dot `0.625rem` across, `0.5rem` after the word.

Colours: black `#000`, white `#fff`, green `#34d399` (Tailwind emerald-400), the only accent.
