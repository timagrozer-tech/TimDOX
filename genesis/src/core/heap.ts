/** Двоичная куча по приоритету (минимум сверху) для Дейкстры и priority-flood. Без лишних объектов. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(capacity = 1024) { this.keys = new Float64Array(capacity); this.vals = new Int32Array(capacity); }
  private grow(): void {
    const k = new Float64Array(this.keys.length * 2); k.set(this.keys); this.keys = k;
    const v = new Int32Array(this.vals.length * 2); v.set(this.vals); this.vals = v;
  }
  push(key: number, val: number): void {
    if (this.size === this.keys.length) this.grow();
    let i = this.size++;
    const K = this.keys, V = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p]! <= key) break;
      K[i] = K[p]!; V[i] = V[p]!; i = p;
    }
    K[i] = key; V[i] = val;
  }
  /** Ключ верхнего элемента */
  peekKey(): number { return this.keys[0]!; }
  pop(): number {
    const K = this.keys, V = this.vals;
    const top = V[0]!;
    const n = --this.size;
    if (n > 0) {
      const key = K[n]!, val = V[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1]! < K[c]!) c++;
        if (K[c]! >= key) break;
        K[i] = K[c]!; V[i] = V[c]!; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
  clear(): void { this.size = 0; }
}
