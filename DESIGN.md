# DESIGN.md — Clawd / NanoClaw Design System

## Brand Identity

**Product name:** Clawd (the AI assistant) / NanoClaw (the platform)
**Tagline:** "The AI assistant that actually gets to know you."
**Audience:** Busy professionals in Southeast Asia. Premium but approachable.
**Tone:** Warm, intelligent, personal — like a trusted concierge, not a cold SaaS tool.

---

## Colour Palette

### Primary (Light mode only — no dark mode)

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#F5F0E8` | Page background — warm oatmeal parchment |
| `--surface` | `#FDFAF4` | Card / panel surface |
| `--surface-elevated` | `#FFFFFF` | Modal, dropdown, top layer |
| `--text` | `#3D2B1F` | Body text — deep espresso |
| `--text-muted` | `#8C7355` | Secondary labels, hints |
| `--accent` | `#C9973A` | Mustard gold — primary interactive colour |
| `--accent-mustard` | `#C9973A` | Alias for `--accent` |
| `--border` | `rgba(61,43,31,0.12)` | Dividers, input borders |
| `--success` | `#4A7C59` | Connected, healthy states |
| `--warning` | `#C9973A` | Pending, caution states (reuses accent) |
| `--danger` | `#A0522D` | Errors, destructive actions |

### Do not use
- Pure `#000000` or `#FFFFFF` backgrounds
- Blue as a primary colour (off-brand for the warm stationery aesthetic)
- High-saturation neons

---

## Typography

```css
--font-serif:  'Playfair Display', Georgia, serif;   /* headings */
--font-sans:   'Inter', system-ui, sans-serif;        /* body, UI */
--font-mono:   'Courier New', monospace;              /* code, tokens */
```

### Scale
| Use | Family | Weight | Size |
|---|---|---|---|
| Hero H1 | Serif | 700 | clamp(2.4rem, 5vw, 3.8rem) |
| Section H2 | Serif | 700 | 2rem |
| Card title | Sans | 600 | 1rem |
| Body | Sans | 400 | 1rem / 1.6 line-height |
| Small / hint | Sans | 400 | 0.8rem |
| Badge / label | Sans | 600 | 0.75rem uppercase |

---

## Spacing & Layout

- Base unit: `8px`
- Card padding: `24px`
- Section gap: `80px` top/bottom
- Container max-width: `1100px`, centred
- Grid: CSS Grid, `auto-fit`, `minmax(280px, 1fr)` for feature cards
- Border radius: `12px` cards, `8px` inputs/buttons, `4px` badges

---

## Components

### Cards
```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: 12px;
padding: 24px;
box-shadow: 0 2px 8px rgba(61,43,31,0.06);
```

### Buttons
- **Primary:** `background: var(--accent)`, white text, `border-radius: 8px`, `padding: 10px 20px`
- **Ghost:** `background: transparent`, `border: 1px solid var(--border)`, text colour
- **Danger:** `background: var(--danger)`, white text
- Hover: darken by ~8% with `filter: brightness(0.92)`
- Focus: `outline: 2px solid var(--accent)`, `outline-offset: 2px`

### Badges / status pills
```css
border-radius: 20px; padding: 4px 10px; font-size: 0.75rem; font-weight: 600;
```
- `.status-live`         → green (`#4A7C59` bg, white text)
- `.status-coming-soon`  → muted (`var(--border)` bg, `var(--text-muted)` text)
- `.badge-healthy`       → green
- `.badge-unhealthy`     → red/danger

### Washi tape accent
Applied to the primary CTA button when WhatsApp is live:
```css
.washi-tape::after {
    content: '';
    position: absolute; left: -4px; right: -4px; top: -4px; bottom: -4px;
    background: repeating-linear-gradient(
        -45deg, transparent, transparent 4px,
        rgba(201,151,58,0.15) 4px, rgba(201,151,58,0.15) 8px
    );
    border-radius: 10px; z-index: -1;
}
```

### Section headings (decorative underline)
```css
h2::after {
    content: ''; display: block; width: 48px; height: 3px;
    background: var(--accent-mustard); margin: 12px auto 0; border-radius: 2px;
}
```

### Toggle switch
```html
<label class="toggle-switch">
  <input type="checkbox" id="my-toggle">
  <span class="toggle-slider"></span>
</label>
```
```css
.toggle-switch { width: 48px; height: 26px; }
.toggle-slider { background: var(--border); border-radius: 26px; }
input:checked + .toggle-slider { background: var(--accent); }
```

---

## Motion & Animation

- Prefer `transition: 0.2s ease` for interactive state changes
- Section entrance: `opacity 0.5s ease + translateY(20px → 0)` via IntersectionObserver
- Heading highlight swipe: CSS `width 0.6s ease` on `::after` pseudo-element
- No auto-playing video or heavy CSS animations on load

---

## Page Structure

### Landing page (`/`)
```
<header>  logo + nav (sticky, blur backdrop)
<hero>    badge + h1 + subheadline + CTA button
<features>  4-card grid (icon + title + description)
<how-it-works>  3-step numbered list
<pricing>   single tier card (centred, max-width 400px)
<footer>    links + copyright
```

### Admin dashboard (`/admin`)
```
<header>  logo + "Admin" badge
<tabs>    Overview | Set Up | Documents | Settings
<tab-overview>   SSE-driven health cards + container table
<tab-whatsapp>   WA connection card + Telegram bot + Access control
<tab-documents>  Upload zone + file list
<tab-settings>   Lazy-loaded settings form fragment from /admin/api/settings/html
```

---

## Impeccable Live Notes

- Entry files: `src/static/landing.html` (landing), `src/static/admin.html` (dashboard)
- Dev URL: `http://3.0.132.150:3000`
- Admin requires Basic Auth (`admin` / see `.env`)
- Dynamic data (WA state, health metrics) comes via SSE — impeccable should not alter the SSE-driven DOM nodes
- Prefer editing the `<style>` block at the top of each file; avoid modifying the `<script>` blocks unless fixing a bug
- The design tokens (`--bg`, `--accent`, etc.) are in the `<style>` block of each file — edit there, not inline

---

## Anti-patterns (do not do)

- Do not use Bootstrap or Tailwind utility classes — all styles are custom
- Do not use `px` for font sizes on body text — use `rem`
- Do not add dark mode — the warm stationery palette is intentional
- Do not add loading spinners to SSE-driven content — data arrives in <200ms from EC2
- Do not change the card `border-radius` to 0 or >16px — it breaks brand consistency
- Do not replace Playfair Display headings with sans-serif
