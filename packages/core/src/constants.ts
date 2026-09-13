import type {
  CameraOptions,
  ForceLayoutOptions,
  HudOptions,
  InteractionOptions,
  LabelOptions,
  RenderOptions,
} from './types.js';

/**
 * Defaults tuned on graphs of 500 / 5k / 50k nodes. They favour readability
 * over raw framerate: everything here still holds 60fps at 50k nodes on a
 * 2021-class integrated GPU because the heavy work is instanced.
 */

export const DEFAULT_FORCE: ForceLayoutOptions = {
  charge: -320,
  linkDistance: 46,
  linkStrength: 0.55,
  gravity: 0.035,
  damping: 0.86,
  theta: 0.85,
  clusterStrength: 0.12,
  alphaMin: 0.0025,
  maxIterations: 900,
  useWorker: true,
  dimensions: 3,
};

export const DEFAULT_RENDER: RenderOptions = {
  nodeBaseSize: 4.2,
  nodeSizeExponent: 0.5,
  minNodeSize: 1.6,
  maxNodeSize: 26,
  edgeOpacity: 0.34,
  edgeWidth: 1,
  edgeCurvature: 0.18,
  edgeFlow: true,
  glow: true,
  bloom: true,
  maxPixelRatio: 2,
  grid: true,
  depthFade: true,
  renderOnDemand: false,
};

export const DEFAULT_LABELS: LabelOptions = {
  enabled: true,
  maxVisible: 90,
  minScreenSize: 7,
  fontFamily: "'Inter', 'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontSize: 13,
  declutter: true,
  alwaysShowFocused: true,
};

export const DEFAULT_INTERACTION: InteractionOptions = {
  enableHover: true,
  enableClick: true,
  enableDrag: true,
  focusDimming: true,
  focusDepth: 1,
  idleOrbit: true,
  idleOrbitDelayMs: 12000,
  idleOrbitSpeed: 0.018,
  doubleClickAction: 'focus',
};

export const DEFAULT_CAMERA: CameraOptions = {
  fov: 52,
  near: 1,
  far: 12000,
  minDistance: 18,
  maxDistance: 4200,
  damping: 0.09,
  rotateSpeed: 1,
  zoomSpeed: 1,
  panSpeed: 1,
  flightDurationMs: 900,
};

export const DEFAULT_HUD: HudOptions = {
  search: true,
  legend: true,
  inspector: true,
  stats: true,
  controls: true,
  insights: true,
};

/** Screen-space dim factor applied to out-of-focus elements. */
export const DIM_FACTOR = 0.14;

/** Node scale multipliers for interaction states. */
export const HOVER_SCALE = 1.35;
export const SELECT_SCALE = 1.5;
