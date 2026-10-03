# Contrast check

Run `npm run check:contrast` after any change to the design tokens or to the homepage styles.
It opens /fr and /en from a local Worker, light and dark, at 390 and 1280 px, and prints each text and tile pair with its ratio.
Thresholds: text 4.5, icon tile against its card 3, glyph against its tile 3; card borders are shown for information only.
It exits 1 when a pair fails or a selector matches nothing, so a renamed class shows up instead of passing silently.
It needs the headless Chromium the rendered tests use; without it, it says "not visually verified" and checks the tokens only.
