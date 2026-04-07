# Performance Library Assessment

## Benchmark setup
- Instrumentation enabled with `?perf=1`.
- Automated browser run via `scripts/perf-benchmark.mjs`.
- Scenarios covered:
  - `24x24` board, production -> movement transition.
  - `48x48` board, production -> movement transition.

## Observed timings (optimized SVG path)
- **24x24**
  - `phase.productionToMovement`: ~117.50ms
  - `render.total`: avg ~1.25ms, max ~1.30ms
- **48x48**
  - `phase.productionToMovement`: ~1447.50ms
  - `render.total`: avg ~2.80ms, max ~5.00ms (single sample up to ~4.90ms)

## Interpretation
- Per-frame render cost is now low even on large boards.
- Remaining freeze is concentrated in production -> movement transition at very large map sizes (`48x48`), likely from state/phase-wide computations and transition workload, not only draw calls.

## PixiJS migration gate
- **Decision right now: NO-GO** for immediate renderer migration.
- Rationale:
  - Core frame rendering performance has improved substantially within current SVG architecture.
  - A PixiJS migration would still be multi-week and medium risk (input model, layering parity, replay/VFX parity).
  - Higher ROI next step is targeted transition-path optimization (phase-end computations), then re-benchmark.

## Re-open criteria for PixiJS
- Reconsider migration only if, after transition-path optimization, either:
  - `phase.productionToMovement` still exceeds acceptable UX budget on target board sizes, or
  - sustained frame-time regressions reappear during normal gameplay on large maps.
