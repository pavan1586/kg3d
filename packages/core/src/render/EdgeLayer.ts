import * as THREE from 'three';
import type { EdgeRecord } from '../graph/GraphModel.js';
import type { RenderOptions, Theme } from '../types.js';
import { parseColor } from '../util/color.js';

/**
 * Every edge in a single LineSegments draw call.
 *
 * Edges are the part of a 3D graph that most easily turns into visual noise, so
 * three things are deliberate here: they are drawn behind nodes with additive
 * blending at low opacity, they fade with depth, and only *highlighted* edges
 * get the travelling light pulse. A graph where everything pulses tells you
 * nothing; a graph where one path pulses tells you exactly where to look.
 */

const EDGE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aT;        // 0 at source .. 1 at target
  attribute float aHighlight; // 0 normal, 1 highlighted
  attribute float aDim;

  varying vec3 vColor;
  varying float vT;
  varying float vHighlight;
  varying float vDim;
  varying float vDepth;

  void main() {
    vColor = aColor;
    vT = aT;
    vHighlight = aHighlight;
    vDim = aDim;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  uniform float uTime;
  uniform float uFlow;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uDepthFade;
  uniform vec3 uHighlightColor;

  varying vec3 vColor;
  varying float vT;
  varying float vHighlight;
  varying float vDim;
  varying float vDepth;

  void main() {
    vec3 color = mix(vColor, uHighlightColor, vHighlight * 0.7);
    float alpha = uOpacity * (1.0 + vHighlight * 2.4);

    if (uFlow > 0.5 && vHighlight > 0.5) {
      // A single soft packet sliding source -> target, once per 1.6s.
      float head = fract(uTime * 0.62);
      float d = abs(fract(vT - head + 0.5) - 0.5);
      float pulse = smoothstep(0.14, 0.0, d);
      color += uHighlightColor * pulse * 1.5;
      alpha += pulse * 0.5;
    }

    alpha *= 1.0 - vDim * 0.88;

    if (uDepthFade > 0.5) {
      float fog = smoothstep(uFogNear, uFogFar, vDepth);
      color = mix(color, uFogColor, fog);
      alpha *= 1.0 - fog * 0.8;
    }

    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

export class EdgeLayer {
  readonly object: THREE.LineSegments;

  private edges: EdgeRecord[];
  private segments: number;
  private positions: Float32Array;
  private colors: Float32Array;
  private tValues: Float32Array;
  private highlights: Float32Array;
  private dims: Float32Array;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;
  private curvature: number;
  /** Vertices written per edge = segments * 2 (line list). */
  private verticesPerEdge: number;

  constructor(edges: EdgeRecord[], theme: Theme, options: RenderOptions) {
    this.edges = edges;
    this.curvature = options.edgeCurvature;

    // Curved edges cost vertices. Past ~25k edges the arcs stop being readable
    // anyway, so straight segments are both faster and clearer.
    this.segments = options.edgeCurvature > 0 && edges.length <= 25000 ? 10 : 1;
    this.verticesPerEdge = this.segments * 2;

    const vertexCount = edges.length * this.verticesPerEdge;
    this.positions = new Float32Array(vertexCount * 3);
    this.colors = new Float32Array(vertexCount * 3);
    this.tValues = new Float32Array(vertexCount);
    this.highlights = new Float32Array(vertexCount);
    this.dims = new Float32Array(vertexCount);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aT', new THREE.BufferAttribute(this.tValues, 1));
    this.geometry.setAttribute('aHighlight', new THREE.BufferAttribute(this.highlights, 1));
    this.geometry.setAttribute('aDim', new THREE.BufferAttribute(this.dims, 1));
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).setUsage(
      THREE.DynamicDrawUsage,
    );

    this.material = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: theme.name === 'daylight' ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        uOpacity: { value: options.edgeOpacity },
        uTime: { value: 0 },
        uFlow: { value: options.edgeFlow ? 1 : 0 },
        uFogColor: { value: new THREE.Color(theme.backgroundDeep) },
        uFogNear: { value: theme.fogNear },
        uFogFar: { value: theme.fogFar },
        uDepthFade: { value: options.depthFade ? 1 : 0 },
        uHighlightColor: { value: new THREE.Color(theme.edgeHighlight) },
      },
    });

    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 0;

    this.applyBaseColors(theme);
    this.writeParametricT();
  }

  private applyBaseColors(theme: Theme): void {
    const fallback = parseColor(theme.edgeColor);
    for (let e = 0; e < this.edges.length; e++) {
      const c = this.edges[e].color ? parseColor(this.edges[e].color as string) : fallback;
      const start = e * this.verticesPerEdge;
      for (let v = 0; v < this.verticesPerEdge; v++) {
        const o = (start + v) * 3;
        this.colors[o] = c.r;
        this.colors[o + 1] = c.g;
        this.colors[o + 2] = c.b;
      }
    }
    (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
  }

  private writeParametricT(): void {
    for (let e = 0; e < this.edges.length; e++) {
      const start = e * this.verticesPerEdge;
      for (let s = 0; s < this.segments; s++) {
        this.tValues[start + s * 2] = s / this.segments;
        this.tValues[start + s * 2 + 1] = (s + 1) / this.segments;
      }
    }
    (this.geometry.getAttribute('aT') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Recompute geometry from the current node positions. */
  updatePositions(nodePositions: Float32Array): void {
    const pos = this.positions;
    const seg = this.segments;
    const curve = this.curvature;

    for (let e = 0; e < this.edges.length; e++) {
      const edge = this.edges[e];
      const si = edge.sourceIndex * 3;
      const ti = edge.targetIndex * 3;
      const sx = nodePositions[si];
      const sy = nodePositions[si + 1];
      const sz = nodePositions[si + 2];
      const tx = nodePositions[ti];
      const ty = nodePositions[ti + 1];
      const tz = nodePositions[ti + 2];
      const base = e * this.verticesPerEdge * 3;

      if (seg === 1) {
        pos[base] = sx;
        pos[base + 1] = sy;
        pos[base + 2] = sz;
        pos[base + 3] = tx;
        pos[base + 4] = ty;
        pos[base + 5] = tz;
        continue;
      }

      // Quadratic arc: the control point is the midpoint pushed perpendicular to
      // the edge, which separates reciprocal pairs and stops long edges from
      // slicing straight through unrelated clusters.
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const mz = (sz + tz) / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const dz = tz - sz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      // Perpendicular via cross(direction, up). Degenerate for vertical edges,
      // so fall back to the x axis in that case.
      let px = -dz;
      let py = 0;
      let pz = dx;
      let plen = Math.sqrt(px * px + py * py + pz * pz);
      if (plen < 1e-5) {
        px = 1;
        py = 0;
        pz = 0;
        plen = 1;
      }
      const lift = len * curve * 0.5;
      px = (px / plen) * lift;
      py = (py / plen) * lift;
      pz = (pz / plen) * lift;
      const cx = mx + px;
      const cy = my + py;
      const cz = mz + pz;

      for (let s = 0; s < seg; s++) {
        const t0 = s / seg;
        const t1 = (s + 1) / seg;
        const o = base + s * 6;
        quadratic(pos, o, sx, sy, sz, cx, cy, cz, tx, ty, tz, t0);
        quadratic(pos, o + 3, sx, sy, sz, cx, cy, cz, tx, ty, tz, t1);
      }
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  setEdgeHighlight(edgeIndex: number, value: number): void {
    const start = edgeIndex * this.verticesPerEdge;
    for (let v = 0; v < this.verticesPerEdge; v++) this.highlights[start + v] = value;
  }

  setEdgeDim(edgeIndex: number, value: number): void {
    const start = edgeIndex * this.verticesPerEdge;
    for (let v = 0; v < this.verticesPerEdge; v++) this.dims[start + v] = value;
  }

  clearHighlights(dim = 0): void {
    this.highlights.fill(0);
    this.dims.fill(dim);
  }

  markHighlights(): void {
    (this.geometry.getAttribute('aHighlight') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aDim') as THREE.BufferAttribute).needsUpdate = true;
  }

  setEdgeColor(edgeIndex: number, r: number, g: number, b: number): void {
    const start = edgeIndex * this.verticesPerEdge;
    for (let v = 0; v < this.verticesPerEdge; v++) {
      const o = (start + v) * 3;
      this.colors[o] = r;
      this.colors[o + 1] = g;
      this.colors[o + 2] = b;
    }
  }

  markColors(): void {
    (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = value;
  }

  setFlow(enabled: boolean): void {
    this.material.uniforms.uFlow.value = enabled ? 1 : 0;
  }

  applyTheme(theme: Theme): void {
    this.material.uniforms.uFogColor.value = new THREE.Color(theme.backgroundDeep);
    this.material.uniforms.uFogNear.value = theme.fogNear;
    this.material.uniforms.uFogFar.value = theme.fogFar;
    this.material.uniforms.uHighlightColor.value = new THREE.Color(theme.edgeHighlight);
    this.material.blending =
      theme.name === 'daylight' ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.material.needsUpdate = true;
    this.applyBaseColors(theme);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function quadratic(
  out: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  z0: number,
  cx: number,
  cy: number,
  cz: number,
  x1: number,
  y1: number,
  z1: number,
  t: number,
): void {
  const it = 1 - t;
  const a = it * it;
  const b = 2 * it * t;
  const c = t * t;
  out[offset] = a * x0 + b * cx + c * x1;
  out[offset + 1] = a * y0 + b * cy + c * y1;
  out[offset + 2] = a * z0 + b * cz + c * z1;
}
