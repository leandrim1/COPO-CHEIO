# COPO CHEIO – Disk Bebidas

Hero section (single page) built with React, TypeScript, Vite, Tailwind CSS and Lucide React.

```bash
npm install
npm run dev      # development server
npm run build    # type-check + production build
```

- All of the page lives in `src/App.tsx`.
- Brand assets are in `public/`: `logo.png` (round emblem) and `public/bebidas/*.webp`, the drinks that rotate in the hero.
- Every drink image is a transparent 1100×1100 canvas with the product centred, scaled to the same height and resting on the same baseline, so they swap in place at the same size. To add a drink, export it the same way, drop it in `public/bebidas/` and add an entry to `DRINKS` in `src/App.tsx`.
- The "Pedir agora" buttons point to `ORDER_HREF` at the top of `src/App.tsx`; swap it for the WhatsApp link (`https://wa.me/55...`) when available.
