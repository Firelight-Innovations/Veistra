/**
 * Shapes for the diff's tests, made in code so a test says what it is made
 * of. Nine floats a triangle, as the diff takes them.
 */

/**
 * An n × n grid of quads over [0, size] in x and z, at height `h(x, z)`, two
 * triangles a quad. `skip(i, k)` leaves quad (i, k) out.
 */
export function plane(
  n: number,
  size: number,
  h: (x: number, z: number) => number = () => 0,
  skip: (i: number, k: number) => boolean = () => false,
): Float32Array {
  const out: number[] = [];
  const s = size / n;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (skip(i, k)) continue;
      const [x0, x1, z0, z1] = [i * s, i * s + s, k * s, k * s + s];
      const p = [
        [x0, h(x0, z0), z0],
        [x1, h(x1, z0), z0],
        [x1, h(x1, z1), z1],
        [x0, h(x0, z1), z1],
      ];
      for (const c of [0, 1, 2, 0, 2, 3]) out.push(...p[c]);
    }
  }
  return Float32Array.from(out);
}

/** An axis-aligned box: 12 triangles. */
export function box(min: number[], max: number[]): Float32Array {
  const corner = (m: number) => [0, 1, 2].map((k) => ((m >> k) & 1 ? max[k] : min[k]));
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of faces) {
    for (const m of [a, b, c, a, c, d]) out.push(...corner(m));
  }
  return Float32Array.from(out);
}

/** `t` moved by (dx, dy, dz). */
export function moved(t: Float32Array, dx: number, dy: number, dz: number): Float32Array {
  return t.map((v, i) => v + [dx, dy, dz][i % 3]);
}

export function concat(...lists: Float32Array[]): Float32Array {
  const out = new Float32Array(lists.reduce((n, l) => n + l.length, 0));
  let w = 0;
  for (const l of lists) {
    out.set(l, w);
    w += l.length;
  }
  return out;
}
