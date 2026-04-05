import {
  ARTILLERY_VFX_LABELS,
  ARTILLERY_VFX_PRESET_IDS,
  playArtilleryProjectile,
  type ArtilleryVfxPresetId,
} from './artilleryProjectileVfx';

const panels = document.getElementById('panels');
if (!panels) throw new Error('#panels missing');

/** Shared “board” geometry so each demo reads clearly. */
function svgScene(preset: ArtilleryVfxPresetId): { svg: SVGSVGElement; from: { x: number; y: number }; to: { x: number; y: number } } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 300');
  svg.setAttribute('aria-label', `Artillery demo: ${preset}`);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', `hex-dim-${preset}`);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  s1.setAttribute('offset', '0%');
  s1.setAttribute('stop-color', '#3d4a5c');
  const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  s2.setAttribute('offset', '100%');
  s2.setAttribute('stop-color', '#2a3340');
  grad.appendChild(s1);
  grad.appendChild(s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const attacker = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  attacker.setAttribute(
    'points',
    '72,210 108,210 118,248 62,248',
  );
  attacker.setAttribute('fill', `url(#hex-dim-${preset})`);
  attacker.setAttribute('stroke', 'rgba(255,255,255,0.12)');
  attacker.setAttribute('stroke-width', '1');
  svg.appendChild(attacker);

  const target = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  target.setAttribute(
    'points',
    '288,78 324,78 334,116 278,116',
  );
  target.setAttribute('fill', '#35475a');
  target.setAttribute('stroke', 'rgba(255,255,255,0.18)');
  target.setAttribute('stroke-width', '1');
  svg.appendChild(target);

  const unitA = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  unitA.setAttribute('cx', '95');
  unitA.setAttribute('cy', '232');
  unitA.setAttribute('r', '14');
  unitA.setAttribute('fill', '#4a7ab8');
  unitA.setAttribute('stroke', '#2d4a72');
  unitA.setAttribute('stroke-width', '2');
  svg.appendChild(unitA);

  const unitB = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  unitB.setAttribute('x', '296');
  unitB.setAttribute('y', '88');
  unitB.setAttribute('width', '28');
  unitB.setAttribute('height', '22');
  unitB.setAttribute('rx', '4');
  unitB.setAttribute('fill', '#c45c3e');
  unitB.setAttribute('stroke', '#8a3d28');
  unitB.setAttribute('stroke-width', '2');
  svg.appendChild(unitB);

  return {
    svg,
    from: { x: 95, y: 232 },
    to: { x: 310, y: 99 },
  };
}

const STAGGER_S = 0.55;

ARTILLERY_VFX_PRESET_IDS.forEach((preset, index) => {
  const wrap = document.createElement('article');
  wrap.className = 'panel';
  const h2 = document.createElement('h2');
  h2.textContent = preset.replace(/([A-Z])/g, ' $1').trim();
  const desc = document.createElement('p');
  desc.className = 'desc';
  desc.textContent = ARTILLERY_VFX_LABELS[preset];
  const { svg, from, to } = svgScene(preset);
  wrap.appendChild(h2);
  wrap.appendChild(desc);
  wrap.appendChild(svg);
  panels.appendChild(wrap);

  window.setTimeout(() => {
    playArtilleryProjectile({ svg, from, to, preset });
  }, index * STAGGER_S * 1000);
});
