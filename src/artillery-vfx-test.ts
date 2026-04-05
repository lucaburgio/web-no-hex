import {
  ARTILLERY_HEX_BARRAGE_LABELS,
  ARTILLERY_HEX_BARRAGE_PRESET_IDS,
  playDefenderHexBarrage,
  type ArtilleryHexBarragePresetId,
} from './artilleryProjectileVfx';

const panels = document.getElementById('panels');
if (!panels) throw new Error('#panels missing');

/** One defender hex + unit; barrage is centered on the hex (no attacker→defender line). */
function svgScene(preset: ArtilleryHexBarragePresetId): {
  svg: SVGSVGElement;
  center: { x: number; y: number };
  hexRadius: number;
} {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 300');
  svg.setAttribute('aria-label', `Hex barrage demo: ${preset}`);

  const cx = 200;
  const cy = 155;
  const hexR = 52;

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 6) + (i * Math.PI) / 3;
    pts.push(`${cx + hexR * Math.cos(a)},${cy + hexR * Math.sin(a)}`);
  }
  bg.setAttribute('points', pts.join(' '));
  bg.setAttribute('fill', '#2d3545');
  bg.setAttribute('stroke', 'rgba(255,255,255,0.2)');
  bg.setAttribute('stroke-width', '1.5');
  svg.appendChild(bg);

  const unit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  unit.setAttribute('x', String(cx - 16));
  unit.setAttribute('y', String(cy - 12));
  unit.setAttribute('width', '32');
  unit.setAttribute('height', '24');
  unit.setAttribute('rx', '5');
  unit.setAttribute('fill', '#c45c3e');
  unit.setAttribute('stroke', '#8a3d28');
  unit.setAttribute('stroke-width', '2');
  svg.appendChild(unit);

  return {
    svg,
    center: { x: cx, y: cy },
    hexRadius: hexR * 0.55,
  };
}

const STAGGER_S = 0.72;

ARTILLERY_HEX_BARRAGE_PRESET_IDS.forEach((preset, index) => {
  const wrap = document.createElement('article');
  wrap.className = 'panel';
  const h2 = document.createElement('h2');
  h2.textContent = preset.replace(/([A-Z])/g, ' $1').trim();
  const desc = document.createElement('p');
  desc.className = 'desc';
  desc.textContent = ARTILLERY_HEX_BARRAGE_LABELS[preset];
  const { svg, center, hexRadius } = svgScene(preset);
  wrap.appendChild(h2);
  wrap.appendChild(desc);
  wrap.appendChild(svg);
  panels.appendChild(wrap);

  window.setTimeout(() => {
    playDefenderHexBarrage({
      svg,
      center,
      hexRadius,
      preset,
    });
  }, index * STAGGER_S * 1000);
});
