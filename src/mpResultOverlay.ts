import gsap from 'gsap';

/** Default GSAP entrance preset for the multiplayer end screen (`src/main.ts`). */
export const DEFAULT_MP_RESULT_VARIANT = 10;

export interface MpResultOverlayEls {
  overlay: HTMLElement;
  text: HTMLElement;
  actions?: HTMLElement | null;
}

let activeCtx: gsap.Context | null = null;
let savedPlainText = '';
let lastEls: MpResultOverlayEls | null = null;

function killSplitChars(textEl: HTMLElement): void {
  if (savedPlainText) {
    textEl.textContent = savedPlainText;
    savedPlainText = '';
  }
}

export function revertMpResultIntro(): void {
  const els = lastEls;
  activeCtx?.revert();
  activeCtx = null;
  if (els?.overlay) {
    els.overlay.querySelectorAll('.mp-result-curtain').forEach(el => el.remove());
    gsap.set(els.overlay, {
      clearProps:
        'transform,top,left,right,bottom,width,height,xPercent,yPercent,scale,scaleX,scaleY,clipPath,filter,opacity',
    });
  }
  if (els?.text) killSplitChars(els.text);
  lastEls = null;
}

function runVariant(variant: number, els: MpResultOverlayEls): void {
  const { overlay, text, actions } = els;
  const v = variant >= 1 && variant <= 11 ? variant : 1;

  killSplitChars(text);

  switch (v) {
    case 1: {
      gsap.set(overlay, { opacity: 0 });
      gsap.set(text, { opacity: 0, scale: 0.85 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.to(overlay, { opacity: 1, duration: 0.35, ease: 'power2.out' });
      tl.to(text, { opacity: 1, scale: 1, duration: 0.55, ease: 'power2.out' }, '-=0.2');
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.25');
      break;
    }
    case 2: {
      gsap.set(overlay, { opacity: 1 });
      gsap.set(text, { opacity: 0, filter: 'blur(14px)' });
      if (actions) gsap.set(actions, { opacity: 0 });
      gsap.to(text, {
        opacity: 1,
        filter: 'blur(0px)',
        duration: 0.85,
        ease: 'power2.out',
      });
      if (actions) {
        gsap.to(actions, { opacity: 1, duration: 0.4, delay: 0.35, ease: 'power2.out' });
      }
      break;
    }
    case 3: {
      gsap.set(overlay, { opacity: 1 });
      gsap.set(text, { opacity: 0, y: 72 });
      if (actions) gsap.set(actions, { opacity: 0, y: 24 });
      const tl = gsap.timeline();
      tl.to(text, { opacity: 1, y: 0, duration: 0.75, ease: 'power4.out' });
      if (actions) {
        tl.to(actions, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' }, '-=0.35');
      }
      break;
    }
    case 4: {
      savedPlainText = text.textContent ?? '';
      const chars = [...savedPlainText].map(ch => {
        const span = document.createElement('span');
        span.className = 'mp-result-char';
        span.textContent = ch === ' ' ? '\u00a0' : ch;
        return span;
      });
      text.replaceChildren(...chars);
      gsap.set(overlay, { opacity: 1 });
      if (actions) gsap.set(actions, { opacity: 0 });
      gsap.fromTo(
        chars,
        { opacity: 0, y: 36 },
        {
          opacity: 1,
          y: 0,
          duration: 0.42,
          stagger: 0.055,
          ease: 'back.out(1.85)',
        },
      );
      if (actions) {
        gsap.to(actions, { opacity: 1, duration: 0.4, delay: 0.35, ease: 'power2.out' });
      }
      break;
    }
    case 5: {
      const left = document.createElement('div');
      const right = document.createElement('div');
      left.className = 'mp-result-curtain mp-result-curtain--left';
      right.className = 'mp-result-curtain mp-result-curtain--right';
      overlay.prepend(right);
      overlay.prepend(left);
      gsap.set(overlay, { opacity: 1 });
      gsap.set([left, right], { width: '50%' });
      gsap.set(text, { opacity: 0 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline({
        onComplete: () => {
          left.remove();
          right.remove();
        },
      });
      tl.to([left, right], {
        width: '0%',
        duration: 0.65,
        ease: 'power3.inOut',
      });
      tl.to(text, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.2');
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.2');
      break;
    }
    case 6: {
      gsap.set(overlay, { opacity: 1 });
      gsap.set(text, { opacity: 0, scale: 0 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.to(text, { opacity: 1, scale: 1, duration: 1.05, ease: 'elastic.out(1, 0.45)' });
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.35');
      break;
    }
    case 7: {
      gsap.set(overlay, {
        opacity: 1,
        perspective: 900,
        transformStyle: 'preserve-3d',
      });
      gsap.set(text, {
        opacity: 0,
        rotationX: -88,
        transformOrigin: '50% 50%',
      });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.to(text, { opacity: 1, rotationX: 0, duration: 0.75, ease: 'power3.out' });
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.3');
      break;
    }
    case 8: {
      gsap.set(overlay, { opacity: 1 });
      gsap.set(text, { opacity: 0, x: 0 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.fromTo(text, { opacity: 0 }, { opacity: 1, duration: 0.08, ease: 'power1.out' });
      for (let i = 0; i < 10; i++) {
        tl.to(text, {
          x: (i % 2 === 0 ? 1 : -1) * (4 + (i % 3)),
          duration: 0.035,
          ease: 'none',
        });
      }
      tl.to(text, { x: 0, duration: 0.06, ease: 'power2.out' });
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.1');
      break;
    }
    case 9: {
      gsap.set(overlay, {
        opacity: 1,
        clipPath: 'circle(0% at 50% 50%)',
      });
      gsap.set(text, { opacity: 0, scale: 0.96 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.to(overlay, {
        clipPath: 'circle(150% at 50% 50%)',
        duration: 0.95,
        ease: 'power3.inOut',
      });
      tl.to(text, { opacity: 1, scale: 1, duration: 0.5, ease: 'power2.out' }, '-=0.45');
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.3');
      break;
    }
    case 10: {
      /** Horizontal line reveal: expand from mid-screen (scaleY), full-screen cover. */
      gsap.set(overlay, {
        clearProps: 'top,left,right,bottom,width,height,xPercent,yPercent,clipPath',
      });
      gsap.set(overlay, {
        opacity: 1,
        scaleY: 0,
        transformOrigin: '50% 50%',
        force3D: true,
      });
      gsap.set(text, { opacity: 0 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.to(overlay, { scaleY: 1, duration: 0.55, ease: 'power3.out' });
      tl.to(text, { opacity: 1, duration: 0.38, ease: 'power2.out' }, '-=0.2');
      if (actions) tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.22');
      break;
    }
    case 11: {
      /** Starts below the viewport as a centered 60vw strip; eases to full-screen cover. */
      gsap.set(overlay, { opacity: 1, clearProps: 'clipPath,scaleY' });
      gsap.set(text, { opacity: 0 });
      if (actions) gsap.set(actions, { opacity: 0 });
      const tl = gsap.timeline();
      tl.fromTo(
        overlay,
        {
          top: '100vh',
          left: '50%',
          width: '60vw',
          height: '100vh',
          xPercent: -50,
        },
        {
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          xPercent: 0,
          duration: 0.92,
          ease: 'power2.inOut',
        },
        0,
      );
      tl.to(text, { opacity: 1, duration: 0.45, ease: 'power2.out' }, '-=0.34');
      if (actions) {
        tl.to(actions, { opacity: 1, duration: 0.35, ease: 'power2.out' }, '-=0.28');
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Plays the chosen GSAP entrance. Call {@link revertMpResultIntro} when the overlay is dismissed
 * so inline styles and split-letter DOM are cleaned up.
 */
export function playMpResultIntro(variant: number, els: MpResultOverlayEls): void {
  revertMpResultIntro();
  lastEls = els;
  activeCtx = gsap.context(() => {
    runVariant(variant, els);
  }, els.overlay);
}
