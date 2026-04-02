# Web Strategic — Design System

## Visual Language

Retro terminal / 80s strategy game aesthetic. Monospace font, dark green panels, amber/gold accents. No drop shadows — 1px solid borders only.

**Font:** `'Disket Mono'`, monospace  
**Base colors:** see CSS custom properties in `:root` (`style.css` and `public/themes/`)

---

## Components

### Tooltip

Dark semi-transparent panel that floats near the trigger element. Used for contextual information that should not block interaction.

**Structure:**
```html
<div id="my-tooltip" class="hidden">
  <div class="tt-title">SECTION TITLE</div>
  <!-- content rows -->
</div>
```

**CSS (copy verbatim for the container):**
```css
#my-tooltip {
  position: fixed;
  z-index: 100;
  background: #0b160b;
  border: 1px solid #3a6a3a;
  padding: 10px 12px;
  font-size: 0.7rem;
  color: #aaccaa;
  pointer-events: none;
  min-width: 220px;
  line-height: 1.5;
}
#my-tooltip.hidden { display: none; }
```

**Content classes (shared, already defined in `style.css`):**

| Class | Purpose | Color |
|---|---|---|
| `.tt-title` | Section header, uppercase, letter-spaced | `#5a9a5a` |
| `.tt-divider` | `<hr>` separator | `#1e2e1e` border |
| `.tt-outcome` | Result line (default) | `#ccddcc` |
| `.tt-outcome.win` | Positive result | `#6ada8a` |
| `.tt-outcome.lose` | Negative result | `#da6a6a` |
| `.tt-outcome.both` | Mixed result | `#da9a4a` |
| `.tt-dmg` | Damage / warning value | `#cc7744` |
| `.tt-cs` | Secondary stat line | `#88aa88` |
| `.tt-factors` | Fine-print detail | `#6a8a6a` |

**Key/value row pattern** (used in PP tooltip):
```html
<div class="pp-tt-row">
  <span>Label</span>
  <span>Value</span>
</div>
```
```css
.my-tt-row { display: flex; justify-content: space-between; gap: 16px; }
.my-tt-row span:first-child { color: #6a9a6a; }
.my-tt-row span:last-child  { color: #aaccaa; }
```

**Positioning:** set via JS on `mousemove` (dynamic) or fixed anchor (static). Clamp to viewport edges.

**Toggle:** add/remove `.hidden` class — never use `display` inline.

**Existing instances:** `#combat-tooltip` (dynamic, mousemove), `#pp-tooltip` (fixed anchor, mouseenter/mouseleave).
