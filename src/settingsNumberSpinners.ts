/** Wrap `.settings-input[type="number"]` with custom stepper buttons (native spinners stay hidden in CSS). */
export function initSettingsNumberSpinners(): void {
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input.settings-input[type="number"]',
  );
  for (const input of inputs) {
    if (input.closest('.settings-number-wrap')) continue;
    const parent = input.parentNode;
    if (!parent) continue;

    const wrap = document.createElement('div');
    wrap.className = 'settings-number-wrap';

    const spin = document.createElement('div');
    spin.className = 'settings-number-spin';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'settings-number-btn settings-number-btn-up';
    up.setAttribute('aria-label', 'Increase value');
    const upArrow = document.createElement('span');
    upArrow.className = 'settings-number-arrow settings-number-arrow-up';
    upArrow.setAttribute('aria-hidden', 'true');
    up.appendChild(upArrow);

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'settings-number-btn settings-number-btn-down';
    down.setAttribute('aria-label', 'Decrease value');
    const downArrow = document.createElement('span');
    downArrow.className = 'settings-number-arrow settings-number-arrow-down';
    downArrow.setAttribute('aria-hidden', 'true');
    down.appendChild(downArrow);

    spin.append(up, down);
    parent.insertBefore(wrap, input);
    wrap.append(input, spin);

    const notify = () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const step = (dir: 1 | -1) => {
      if (input.disabled) return;
      const before = input.value;
      try {
        if (dir === 1) input.stepUp();
        else input.stepDown();
      } catch {
        return;
      }
      if (input.value !== before) notify();
    };

    up.addEventListener('click', e => {
      e.preventDefault();
      step(1);
    });
    down.addEventListener('click', e => {
      e.preventDefault();
      step(-1);
    });
  }
}
