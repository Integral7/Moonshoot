// Fixed-step integrators. The simulation always advances in fixed steps so
// results (and replays) are independent of frame rate.

/** dy/dt = f(t, y). Writes into `out`. */
export type Derivative = (t: number, y: Float64Array, out: Float64Array) => void;

/** Classic 4th-order Runge-Kutta with preallocated scratch buffers. */
export class RK4 {
  private k1: Float64Array;
  private k2: Float64Array;
  private k3: Float64Array;
  private k4: Float64Array;
  private tmp: Float64Array;

  constructor(readonly n: number) {
    this.k1 = new Float64Array(n);
    this.k2 = new Float64Array(n);
    this.k3 = new Float64Array(n);
    this.k4 = new Float64Array(n);
    this.tmp = new Float64Array(n);
  }

  /** Advance `y` in place by one step of size h starting at time t. */
  step(f: Derivative, t: number, y: Float64Array, h: number): void {
    const { n, k1, k2, k3, k4, tmp } = this;
    f(t, y, k1);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * h * k1[i];
    f(t + 0.5 * h, tmp, k2);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + 0.5 * h * k2[i];
    f(t + 0.5 * h, tmp, k3);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * k3[i];
    f(t + h, tmp, k4);
    const h6 = h / 6;
    for (let i = 0; i < n; i++) y[i] += h6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }

  /** Integrate `steps` fixed steps; returns the final time. */
  integrate(f: Derivative, t: number, y: Float64Array, h: number, steps: number): number {
    for (let s = 0; s < steps; s++) {
      this.step(f, t, y, h);
      t += h;
    }
    return t;
  }
}

/**
 * Semi-implicit (symplectic) Euler for y = [r(3), v(3)] given accel(r).
 * Used in tests as a cross-check; energy drift is bounded.
 */
export function symplecticEulerStep(
  accel: (r: Float64Array, out: Float64Array) => void,
  y: Float64Array,
  h: number,
  scratch: Float64Array = new Float64Array(3),
): void {
  const r = y.subarray(0, 3);
  accel(r, scratch);
  y[3] += h * scratch[0];
  y[4] += h * scratch[1];
  y[5] += h * scratch[2];
  y[0] += h * y[3];
  y[1] += h * y[4];
  y[2] += h * y[5];
}

/**
 * Converts variable real-time frame deltas into a whole number of fixed
 * simulation steps (the "fix your timestep" accumulator).
 */
export class FixedStepper {
  private acc = 0;

  constructor(
    public h: number,
    public maxStepsPerFrame = 2000,
  ) {}

  /**
   * Accumulate `dt` simulated seconds and invoke `step` for each whole step.
   * Returns the number of steps taken. Excess beyond the cap is dropped so the
   * game never spirals.
   */
  advance(dt: number, step: (h: number) => void): number {
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.h && n < this.maxStepsPerFrame) {
      step(this.h);
      this.acc -= this.h;
      n++;
    }
    if (n >= this.maxStepsPerFrame) this.acc = 0;
    return n;
  }

  /** Fraction of a step left in the accumulator, for render interpolation. */
  get alpha(): number {
    return this.acc / this.h;
  }

  reset(): void {
    this.acc = 0;
  }
}
