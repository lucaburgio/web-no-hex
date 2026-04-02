# Web Strategic — Design System

## Visual Language

Retro terminal / 80s strategy game aesthetic. Monospace font, near-black panels, amber/gold accents on white text. No borders, no drop shadows.

**Font:** `'Disket Mono'`, monospace  
**Base colors:** see CSS custom properties in `:root` (`style.css` and `public/themes/`)

---

## Components

### Tooltip

Near-black panel that floats near the trigger element. Title in amber, body in white, stats/values in amber. Everything uppercase.

**Structure:**
```html
<div id="my-tooltip" class="tooltip hidden">
  <div class="tt-title">SECTION TITLE</div>
  <!-- content rows -->
</div>
```

**CSS (copy verbatim for the container — already defined in `style.css`):**
```css
.tooltip {
  position: fixed;
  z-index: 100;
  background: #000100;
  padding: 24px;
  font-size: 0.7rem;
  color: #FFF;
  pointer-events: none;
  min-width: 220px;
  line-height: 1.6;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.tooltip.hidden { display: none; }
```

**Content classes (shared, already defined in `style.css`):**

| Class | Purpose | Color |
|---|---|---|
| `.tt-title` | Section header, amber, bold | `#C77E00` |
| `.tt-divider` | `<hr>` separator | `rgba(255,255,255,0.1)` |
| `.tt-outcome` | Result line (default) | `#FFF` |
| `.tt-outcome.win` | Positive result | `#C77E00` |
| `.tt-outcome.lose` | Negative result | `#da6a6a` |
| `.tt-outcome.both` | Mixed result | `#da9a4a` |
| `.tt-dmg` | Damage / warning value | `#C77E00` |
| `.tt-cs` | Stat value line | `#C77E00` |
| `.tt-factors` | Fine-print detail | `rgba(255,255,255,0.4)` |

**Key/value row pattern** (used in PP tooltip):
```html
<div class="pp-tt-row">
  <span>Label</span>
  <span>Value</span>
</div>
```
Labels render at `rgba(255,255,255,0.6)`, values at `#C77E00`.

**Positioning:**
- Dynamic (follows cursor): call `positionTooltip(pageX, pageY)` after showing — clamps to viewport.
- Anchored (near element): show tooltip, then read `getBoundingClientRect()` on both the anchor and tooltip elements and set `left`/`top` via `style`. Clamp to viewport.

**Toggle:** add/remove `.hidden` class — never use `display` inline.

**Existing instances:** `#combat-tooltip` (dynamic, mousemove), `#pp-tooltip` (anchored to `#pp-info`, mouseenter/mouseleave).
