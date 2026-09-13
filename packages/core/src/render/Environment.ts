import * as THREE from 'three';
import type { Theme } from '../types.js';
import { mulberry32 } from '../util/math.js';

/**
 * The environment does one job: give the eye a stable frame of reference so the
 * graph reads as a volume rather than a flat scatter. A faint ground grid
 * establishes "down", a slow particle field gives parallax when the camera
 * orbits, and a vignette-ish depth gradient pushes the graph forward.
 *
 * It is deliberately almost invisible. If you notice the background, it is
 * doing too much.
 */
export class Environment {
  readonly group = new THREE.Group();

  private particles: THREE.Points | null = null;
  private grid: THREE.LineSegments | null = null;
  private particleMaterial: THREE.PointsMaterial | null = null;
  private gridMaterial: THREE.LineBasicMaterial | null = null;

  constructor(theme: Theme, showGrid: boolean, extent = 1800) {
    if (theme.ambientParticles > 0) this.buildParticles(theme, extent);
    if (showGrid) this.buildGrid(theme, extent);
    this.group.renderOrder = -1;
  }

  private buildParticles(theme: Theme, extent: number): void {
    const count = theme.ambientParticles;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const rand = mulberry32(1337);
    for (let i = 0; i < count; i++) {
      // Shell distribution: dense enough at graph scale to give parallax,
      // sparse in the middle so it never competes with the nodes.
      const r = extent * (0.55 + rand() * 0.9);
      const u = rand() * 2 - 1;
      const theta = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = r * s * Math.cos(theta);
      positions[i * 3 + 1] = r * u * 0.55;
      positions[i * 3 + 2] = r * s * Math.sin(theta);
      sizes[i] = 0.6 + rand() * 1.8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    this.particleMaterial = new THREE.PointsMaterial({
      color: new THREE.Color(theme.labelColor),
      size: 1.6,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(geometry, this.particleMaterial);
    this.particles.frustumCulled = false;
    this.group.add(this.particles);
  }

  private buildGrid(theme: Theme, extent: number): void {
    const divisions = 26;
    const step = (extent * 2) / divisions;
    const positions: number[] = [];
    const alphas: number[] = [];
    for (let i = 0; i <= divisions; i++) {
      const p = -extent + i * step;
      positions.push(-extent, 0, p, extent, 0, p);
      positions.push(p, 0, -extent, p, 0, extent);
      // Fade the outer rings so the grid dissolves instead of ending abruptly.
      const fade = 1 - Math.abs(i / divisions - 0.5) * 2;
      for (let k = 0; k < 4; k++) alphas.push(fade);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aFade', new THREE.Float32BufferAttribute(alphas, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(theme.gridColor) },
        uOpacity: { value: 0.55 },
      },
      vertexShader: /* glsl */ `
        attribute float aFade;
        varying float vFade;
        void main() {
          vFade = aFade;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(uColor, vFade * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.grid = new THREE.LineSegments(geometry, material);
    this.grid.position.y = -extent * 0.42;
    this.grid.frustumCulled = false;
    this.group.add(this.grid);
  }

  /** Very slow counter-rotation; gives depth cues without drawing attention. */
  update(dt: number): void {
    if (this.particles) this.particles.rotation.y += dt * 0.006;
    if (this.grid) this.grid.rotation.y -= dt * 0.002;
  }

  setGridVisible(visible: boolean): void {
    if (this.grid) this.grid.visible = visible;
  }

  applyTheme(theme: Theme): void {
    this.particleMaterial?.color.set(theme.labelColor);
    if (this.particleMaterial) {
      this.particleMaterial.opacity = theme.ambientParticles > 0 ? 0.2 : 0;
    }
    this.gridMaterial?.color.set(theme.gridColor);
    if (this.grid) {
      const mat = this.grid.material as THREE.ShaderMaterial;
      mat.uniforms.uColor.value = new THREE.Color(theme.gridColor);
    }
  }

  dispose(): void {
    this.particles?.geometry.dispose();
    this.particleMaterial?.dispose();
    this.grid?.geometry.dispose();
    (this.grid?.material as THREE.Material | undefined)?.dispose();
    this.group.clear();
  }
}
