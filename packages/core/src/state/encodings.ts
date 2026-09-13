import type { MetricsResult } from '../graph/metrics.js';
import type { GraphModel } from '../graph/GraphModel.js';
import { METRIC_SCHEME_DARK, METRIC_SCHEME_LIGHT } from '../theme/themes.js';
import type { ColorEncoding, MetricName, RenderOptions, SizeEncoding, Theme } from '../types.js';
import { parseColor, sampleScheme } from '../util/color.js';
import { clamp, normalize } from '../util/math.js';

/**
 * Visual encodings — the layer where data becomes colour and size.
 *
 * Two rules are enforced here rather than left to the caller, because getting
 * them wrong is what makes graph visualisations lie:
 *  - size encodes on a square-root-ish scale, so a node with 100x the weight is
 *    10x the radius rather than 100x the area's worth of visual shouting;
 *  - continuous metrics are percentile-clipped before mapping, so one outlier
 *    hub cannot flatten every other node to the bottom of the ramp.
 */

export function metricValues(metrics: MetricsResult, name: MetricName): Float64Array {
  switch (name) {
    case 'degree':
      return metrics.degree;
    case 'inDegree':
      return metrics.inDegree;
    case 'outDegree':
      return metrics.outDegree;
    case 'pagerank':
      return metrics.pagerank;
    case 'betweenness':
      return metrics.betweenness;
    case 'closeness':
      return metrics.closeness;
    case 'clustering':
      return metrics.clustering;
    case 'community':
      return Float64Array.from(metrics.community);
    default:
      return metrics.degree;
  }
}

export function computeColors(
  model: GraphModel,
  encoding: ColorEncoding,
  theme: Theme,
  metrics: MetricsResult | null,
  typeOrder: string[],
): Float32Array {
  const n = model.nodeCount;
  const out = new Float32Array(n * 3);
  const fallback = parseColor(theme.nodeDefault);

  const write = (i: number, c: { r: number; g: number; b: number }) => {
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  };

  switch (encoding.by) {
    case 'constant': {
      const c = parseColor(encoding.color);
      for (let i = 0; i < n; i++) write(i, c);
      break;
    }
    case 'custom': {
      for (let i = 0; i < n; i++) write(i, parseColor(encoding.fn(model.nodes[i])));
      break;
    }
    case 'community': {
      for (let i = 0; i < n; i++) {
        const node = model.nodes[i];
        if (node.color) {
          write(i, parseColor(node.color));
          continue;
        }
        const community = metrics
          ? metrics.community[i]
          : typeof node.group === 'number'
            ? node.group
            : 0;
        write(i, parseColor(theme.palette[community % theme.palette.length]));
      }
      break;
    }
    case 'metric': {
      if (!metrics) {
        for (let i = 0; i < n; i++) write(i, fallback);
        break;
      }
      const scheme =
        encoding.scheme ?? (theme.name === 'daylight' ? METRIC_SCHEME_LIGHT : METRIC_SCHEME_DARK);
      const normalized = normalize(metricValues(metrics, encoding.metric));
      for (let i = 0; i < n; i++) write(i, sampleScheme(scheme, normalized[i]));
      break;
    }
    case 'type':
    default: {
      const order = new Map<string, number>();
      typeOrder.forEach((t, i) => order.set(t, i));
      for (let i = 0; i < n; i++) {
        const node = model.nodes[i];
        if (node.color) {
          write(i, parseColor(node.color));
          continue;
        }
        const idx = order.get(node.type ?? 'Node') ?? 0;
        write(i, parseColor(theme.palette[idx % theme.palette.length]));
      }
      break;
    }
  }
  return out;
}

export function computeRadii(
  model: GraphModel,
  encoding: SizeEncoding,
  render: RenderOptions,
  metrics: MetricsResult | null,
): Float32Array {
  const n = model.nodeCount;
  const out = new Float32Array(n);
  const { nodeBaseSize, nodeSizeExponent, minNodeSize, maxNodeSize } = render;

  const scale = (raw: number) =>
    clamp(
      nodeBaseSize * Math.pow(Math.max(raw, 0.0001), nodeSizeExponent),
      minNodeSize,
      maxNodeSize,
    );

  switch (encoding.by) {
    case 'constant':
      out.fill(nodeBaseSize);
      break;
    case 'custom':
      for (let i = 0; i < n; i++)
        out[i] = clamp(encoding.fn(model.nodes[i]), minNodeSize, maxNodeSize);
      break;
    case 'degree':
      for (let i = 0; i < n; i++) out[i] = scale(1 + model.degreeOf(i));
      break;
    case 'metric': {
      if (!metrics) {
        out.fill(nodeBaseSize);
        break;
      }
      const normalized = normalize(metricValues(metrics, encoding.metric));
      for (let i = 0; i < n; i++) {
        out[i] = clamp(
          minNodeSize + normalized[i] * (maxNodeSize * 0.55 - minNodeSize),
          minNodeSize,
          maxNodeSize,
        );
      }
      break;
    }
    case 'weight':
    default:
      for (let i = 0; i < n; i++) {
        const node = model.nodes[i];
        out[i] =
          typeof node.size === 'number'
            ? clamp(node.size, minNodeSize, maxNodeSize)
            : scale(node.weight ?? 1);
      }
      break;
  }
  return out;
}

/** Legend entries for the current colour encoding. */
export interface LegendEntry {
  label: string;
  color: string;
  count: number;
}

export function buildLegend(
  model: GraphModel,
  encoding: ColorEncoding,
  theme: Theme,
  metrics: MetricsResult | null,
  typeOrder: string[],
): LegendEntry[] {
  if (encoding.by === 'community' && metrics) {
    const counts = new Map<number, number>();
    for (let i = 0; i < model.nodeCount; i++) {
      counts.set(metrics.community[i], (counts.get(metrics.community[i]) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([id, count]) => ({
        label: `Cluster ${id + 1}`,
        color: theme.palette[id % theme.palette.length],
        count,
      }));
  }
  if (encoding.by === 'metric') {
    return [];
  }
  const counts = new Map<string, number>();
  for (const node of model.nodes) {
    const t = node.type ?? 'Node';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return typeOrder.map((t, i) => ({
    label: t,
    color: theme.palette[i % theme.palette.length],
    count: counts.get(t) ?? 0,
  }));
}
