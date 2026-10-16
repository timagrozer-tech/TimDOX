export const clamp = (x: number, a = 0, b = 1): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const sq = (x: number): number => x * x;
/** Логистический рост: прирост за шаг */
export const logistic = (p: number, cap: number, r: number): number => (cap <= 0 ? -p * 0.2 : r * p * (1 - p / cap));
