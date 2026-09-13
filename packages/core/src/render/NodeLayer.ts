import * as THREE from 'three';
import type { RenderOptions, Theme } from '../types.js';
import { HOVER_SCALE, SELECT_SCALE } from '../constants.js';

/**
 * All nodes in two draw calls: one instanced sphere mesh for the bodies and one
 * instanced billboard for the additive halo. Instancing is what keeps 50k nodes
 * at 60fps — the alternative, a Mesh per node, dies somewhere around 3k.
 *
 * Per-instance state lives in three attributes:
 *   aColor  vec3  base colour
 *   aState  vec2  x = emphasis (hover/select), y = dim (0 bright .. 1 muted)
 *   aId     vec3  colour-encoded index, read back by the GPU picker
 */

const NODE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute vec2 aState;

  varying vec3 vColor;
  varying vec2 vState;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vDepth;

  void main() {
    vColor = aColor;
    vState = aState;

    vec4 mv = vec4(position, 1.0);
    vec3 objectNormal = normal;
    #ifdef USE_INSTANCING
      mv = instanceMatrix * mv;
      objectNormal = mat3(instanceMatrix) * objectNormal;
    #endif
    mv = modelViewMatrix * mv;

    vNormal = normalize(normalMatrix * objectNormal);
    vViewDir = normalize(-mv.xyz);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uDepthFade;
  uniform vec3 uHighlightColor;
  uniform float uTime;

  varying vec3 vColor;
  varying vec2 vState;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying float vDepth;

  void main() {
    vec3 normal = normalize(vNormal);
    float lambert = clamp(dot(normal, normalize(vec3(0.5, 0.8, 0.6))), 0.0, 1.0);

    // Fresnel rim: reads as a lit sphere without a full PBR pass, and gives the
    // silhouette the crisp edge that keeps dense clusters legible.
    float fresnel = pow(1.0 - clamp(dot(normal, normalize(vViewDir)), 0.0, 1.0), 2.4);

    // Keep the hue: the rim brightens toward a tinted white, not pure white,
    // otherwise every node in a dense cluster reads as the same pale blob once
    // bloom is applied on top.
    vec3 base = vColor * (0.46 + 0.5 * lambert);
    vec3 rim = mix(vColor, vec3(1.0), 0.18) * fresnel * 0.34;
    vec3 color = base + rim;

    // Emphasis pushes the instance toward white and adds a slow breathing pulse
    // so the selected node is unmistakable even in a crowded frame.
    float pulse = 0.5 + 0.5 * sin(uTime * 2.4);
    color = mix(color, uHighlightColor, vState.x * (0.34 + 0.2 * pulse));
    color += vState.x * 0.28 * vColor;

    // Dim, not hide: muted nodes still carry structure.
    color = mix(color, uFogColor, vState.y);
    float alpha = mix(1.0, 0.34, vState.y);

    if (uDepthFade > 0.5) {
      float fog = smoothstep(uFogNear, uFogFar, vDepth);
      color = mix(color, uFogColor, fog * 0.85);
      alpha *= 1.0 - fog * 0.55;
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

const HALO_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute vec2 aState;
  attribute float aScale;

  varying vec3 vColor;
  varying vec2 vState;
  varying vec2 vUv;

  void main() {
    vColor = aColor;
    vState = aState;
    vUv = uv;

    // Billboard: take the instance translation, then offset in view space so the
    // halo always faces the camera regardless of orbit.
    vec4 center = vec4(0.0, 0.0, 0.0, 1.0);
    #ifdef USE_INSTANCING
      center = instanceMatrix * center;
    #endif
    vec4 mv = modelViewMatrix * center;
    mv.xy += position.xy * aScale;
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying vec2 vState;
  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    // Squared falloff reads as light scatter rather than a flat disc.
    float falloff = pow(1.0 - d, 3.1);
    float strength = falloff * uOpacity * (1.0 + vState.x * 1.8) * (1.0 - vState.y * 0.85);
    gl_FragColor = vec4(vColor * strength, strength);
  }
`;

export class NodeLayer {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  readonly halo: THREE.InstancedMesh | null;

  private count: number;
  private colors: Float32Array;
  private states: Float32Array;
  private scales: Float32Array;
  private radii: Float32Array;
  private dummy = new THREE.Object3D();
  private material: THREE.ShaderMaterial;
  private haloMaterial: THREE.ShaderMaterial | null = null;
  private pickingMaterial: THREE.ShaderMaterial;
  private options: RenderOptions;

  constructor(count: number, theme: Theme, options: RenderOptions) {
    this.count = count;
    this.options = options;
    this.colors = new Float32Array(count * 3);
    this.states = new Float32Array(count * 2);
    this.scales = new Float32Array(count);
    this.radii = new Float32Array(count);

    // 16x12 segments: smooth at any realistic on-screen size, 192 triangles.
    const geometry = new THREE.SphereGeometry(1, 16, 12);
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.colors, 3));
    geometry.setAttribute('aState', new THREE.InstancedBufferAttribute(this.states, 2));
    geometry.setAttribute('aId', new THREE.InstancedBufferAttribute(makeIdAttribute(count), 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uFogColor: { value: new THREE.Color(theme.backgroundDeep) },
        uFogNear: { value: theme.fogNear },
        uFogFar: { value: theme.fogFar },
        uDepthFade: { value: options.depthFade ? 1 : 0 },
        uHighlightColor: { value: new THREE.Color(theme.selectionColor) },
        uTime: { value: 0 },
      },
    });

    this.pickingMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aId;
        varying vec3 vId;
        void main() {
          vId = aId;
          vec4 mv = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            mv = instanceMatrix * mv;
          #endif
          gl_Position = projectionMatrix * modelViewMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vId;
        void main() { gl_FragColor = vec4(vId, 1.0); }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);

    if (options.glow) {
      const haloGeometry = new THREE.PlaneGeometry(1, 1);
      haloGeometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.colors, 3));
      haloGeometry.setAttribute('aState', new THREE.InstancedBufferAttribute(this.states, 2));
      haloGeometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(this.scales, 1));
      this.haloMaterial = new THREE.ShaderMaterial({
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        uniforms: { uOpacity: { value: 0.17 } },
      });
      this.halo = new THREE.InstancedMesh(haloGeometry, this.haloMaterial, count);
      this.halo.frustumCulled = false;
      this.halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.halo.renderOrder = 1;
      this.group.add(this.halo);
    } else {
      this.halo = null;
    }
  }

  get instanceCount(): number {
    return this.count;
  }

  /** Radius of a node in world units — used by the camera framing helpers. */
  radiusOf(index: number): number {
    return this.radii[index] ?? 1;
  }

  setRadii(radii: Float32Array): void {
    this.radii.set(radii.subarray(0, this.count));
    for (let i = 0; i < this.count; i++) {
      this.scales[i] = this.radii[i] * 2.6;
    }
    this.markScales();
  }

  setColors(colors: Float32Array): void {
    this.colors.set(colors.subarray(0, this.count * 3));
    this.markColors();
  }

  setColorAt(index: number, r: number, g: number, b: number): void {
    this.colors[index * 3] = r;
    this.colors[index * 3 + 1] = g;
    this.colors[index * 3 + 2] = b;
  }

  setState(index: number, emphasis: number, dim: number): void {
    this.states[index * 2] = emphasis;
    this.states[index * 2 + 1] = dim;
  }

  clearStates(dim = 0): void {
    for (let i = 0; i < this.count; i++) {
      this.states[i * 2] = 0;
      this.states[i * 2 + 1] = dim;
    }
  }

  /** Push positions from the layout buffer into the instance matrices. */
  updatePositions(
    positions: Float32Array,
    hovered = -1,
    selected: Set<number> | null = null,
  ): void {
    const matrix = this.dummy;
    for (let i = 0; i < this.count; i++) {
      const scale =
        this.radii[i] *
        (i === hovered ? HOVER_SCALE : selected && selected.has(i) ? SELECT_SCALE : 1);
      matrix.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      matrix.scale.setScalar(scale);
      matrix.updateMatrix();
      this.mesh.setMatrixAt(i, matrix.matrix);
      this.halo?.setMatrixAt(i, matrix.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.halo) this.halo.instanceMatrix.needsUpdate = true;
  }

  markColors(): void {
    (this.mesh.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    if (this.halo) {
      (this.halo.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  markStates(): void {
    (this.mesh.geometry.getAttribute('aState') as THREE.BufferAttribute).needsUpdate = true;
    if (this.halo) {
      (this.halo.geometry.getAttribute('aState') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  markScales(): void {
    if (this.halo) {
      (this.halo.geometry.getAttribute('aScale') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  applyTheme(theme: Theme): void {
    this.material.uniforms.uFogColor.value = new THREE.Color(theme.backgroundDeep);
    this.material.uniforms.uFogNear.value = theme.fogNear;
    this.material.uniforms.uFogFar.value = theme.fogFar;
    this.material.uniforms.uHighlightColor.value = new THREE.Color(theme.selectionColor);
    if (this.haloMaterial) {
      this.haloMaterial.uniforms.uOpacity.value = theme.name === 'daylight' ? 0.08 : 0.17;
    }
  }

  setGlowOpacity(value: number): void {
    if (this.haloMaterial) this.haloMaterial.uniforms.uOpacity.value = value;
  }

  /** Swap in the id-encoding material for one picking render. */
  beginPicking(): void {
    this.mesh.material = this.pickingMaterial;
    if (this.halo) this.halo.visible = false;
  }

  endPicking(): void {
    this.mesh.material = this.material;
    if (this.halo) this.halo.visible = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.pickingMaterial.dispose();
    this.halo?.geometry.dispose();
    this.haloMaterial?.dispose();
    this.group.clear();
  }
}

/** Encode instance index into a colour the picker can read back exactly. */
function makeIdAttribute(count: number): Float32Array {
  const ids = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // +1 so index 0 is distinguishable from the cleared background.
    const id = i + 1;
    ids[i * 3] = ((id >> 16) & 0xff) / 255;
    ids[i * 3 + 1] = ((id >> 8) & 0xff) / 255;
    ids[i * 3 + 2] = (id & 0xff) / 255;
  }
  return ids;
}
