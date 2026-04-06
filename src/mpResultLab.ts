import { playMpResultIntro, revertMpResultIntro, DEFAULT_MP_RESULT_VARIANT } from './mpResultOverlay';

const defaultEl = document.getElementById('lab-default-variant');
if (defaultEl) defaultEl.textContent = String(DEFAULT_MP_RESULT_VARIANT);

document.querySelectorAll('.lab-panel').forEach(panel => {
  const variant = parseInt((panel as HTMLElement).dataset.variant ?? '1', 10);
  const overlay = panel.querySelector('.lab-overlay') as HTMLElement;
  const text = panel.querySelector('.lab-text') as HTMLElement;
  const actions = panel.querySelector('.lab-actions') as HTMLElement;
  const playBtn = panel.querySelector('.lab-play') as HTMLButtonElement;
  const resetBtn = panel.querySelector('.lab-reset') as HTMLButtonElement;

  playBtn.addEventListener('click', () => {
    text.textContent = 'victory';
    overlay.classList.remove('lab-hidden');
    playMpResultIntro(variant, { overlay, text, actions });
  });

  resetBtn.addEventListener('click', () => {
    revertMpResultIntro();
    overlay.classList.add('lab-hidden');
  });
});
