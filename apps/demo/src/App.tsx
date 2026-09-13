import { useMemo, useRef, useState } from 'react';
import { KnowledgeGraph, useGraphInsights, useLayoutProgress } from '@kg3d/react';
import type { KnowledgeGraphHandle } from '@kg3d/react';
import { RestAdapter } from '@kg3d/core';
import type {
  ColorEncoding,
  GraphAdapter,
  GraphData,
  KnowledgeGraph3D,
  LayoutName,
  ThemeName,
} from '@kg3d/core';
import { generateSampleGraph } from './sampleGraph';
import './styles.css';

type Source = 'sample-small' | 'sample-large' | 'api';

const SOURCE_LABELS: Record<Source, string> = {
  'sample-small': 'Sample · 620 nodes',
  'sample-large': 'Sample · 8,000 nodes',
  api: 'Live API',
};

export default function App() {
  const [source, setSource] = useState<Source>('sample-small');
  const [theme, setTheme] = useState<ThemeName>('obsidian');
  const [layout, setLayout] = useState<LayoutName>('force');
  const [colorBy, setColorBy] = useState<ColorEncoding>({ by: 'community' });
  const [graph, setGraph] = useState<KnowledgeGraph3D | null>(null);
  const handleRef = useRef<KnowledgeGraphHandle | null>(null);

  const insights = useGraphInsights(graph);
  const progress = useLayoutProgress(graph);

  const data: GraphData | undefined = useMemo(() => {
    if (source === 'api') return undefined;
    return generateSampleGraph(
      source === 'sample-large'
        ? { size: 8000, domains: 8, crossDomainRate: 0.05 }
        : { size: 620, domains: 6 },
    );
  }, [source]);

  const adapter: GraphAdapter | undefined = useMemo(() => {
    if (source !== 'api') return undefined;
    return new RestAdapter({
      baseUrl: '/api/v1',
      graphId: 'demo',
      serverLayout: false,
      withMetrics: true,
    });
  }, [source]);

  return (
    <div className="app">
      <header className="app__bar">
        <div className="app__brand">
          <span className="app__mark" aria-hidden />
          <div>
            <strong>kg3d</strong>
            <span>3D knowledge graph explorer</span>
          </div>
        </div>

        <div className="app__controls">
          <label>
            Source
            <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Layout
            <select value={layout} onChange={(e) => setLayout(e.target.value as LayoutName)}>
              {['force', 'cluster', 'sphere', 'radial', 'hierarchy', 'grid'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label>
            Colour
            <select
              value={colorBy.by === 'metric' ? colorBy.metric : colorBy.by}
              onChange={(e) => {
                const value = e.target.value;
                setColorBy(
                  value === 'type' || value === 'community'
                    ? { by: value }
                    : { by: 'metric', metric: value as 'pagerank' },
                );
              }}
            >
              <option value="community">community</option>
              <option value="type">type</option>
              <option value="pagerank">influence</option>
              <option value="betweenness">bridging</option>
            </select>
          </label>

          <label>
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeName)}>
              {['obsidian', 'nebula', 'slate', 'daylight'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <button type="button" onClick={() => handleRef.current?.frameAll()}>
            Fit view
          </button>
        </div>
      </header>

      <main className="app__stage">
        <KnowledgeGraph
          ref={handleRef}
          key={source}
          data={data}
          adapter={adapter}
          theme={theme}
          layout={layout}
          colorBy={colorBy}
          sizeBy={{ by: 'metric', metric: 'pagerank' }}
          computeMetrics
          onReady={setGraph}
          onError={(error, context) => console.error(context, error)}
        />

        {progress.running && (
          <div className="app__progress" role="status">
            <span
              className="app__progress-bar"
              style={{ width: `${Math.min(100, (1 - progress.alpha) * 100).toFixed(0)}%` }}
            />
            <span className="app__progress-label">
              Settling layout · {progress.iteration} iterations
            </span>
          </div>
        )}
      </main>

      <footer className="app__footer">
        {insights ? (
          <>
            <span>
              <b>{insights.nodeCount.toLocaleString()}</b> nodes
            </span>
            <span>
              <b>{insights.edgeCount.toLocaleString()}</b> edges
            </span>
            <span>
              <b>{insights.communities}</b> communities
            </span>
            <span>
              modularity <b>{insights.modularity.toFixed(2)}</b>
            </span>
            <span>
              top hub <b>{insights.hubs[0]?.label ?? '—'}</b>
            </span>
          </>
        ) : (
          <span>Loading graph…</span>
        )}
      </footer>
    </div>
  );
}
