import type { KnowledgeGraph3D } from '../KnowledgeGraph3D.js';
import type { GraphNode, HudOptions, LayoutName, MetricName, Theme, ThemeName } from '../types.js';

/**
 * The built-in heads-up display.
 *
 * Everything here is optional — a host app that wants its own React panels
 * passes `hud: false` and drives the engine through its public API. The default
 * HUD exists so that dropping the library into a page gives you a *usable*
 * tool, not just a pretty canvas: search, legend, an inspector, the analytics
 * summary, and the encoding switches that make the same graph answer different
 * questions.
 */
export class Hud {
  private root: HTMLDivElement;
  private searchInput: HTMLInputElement | null = null;
  private searchResults: HTMLDivElement | null = null;
  private legendEl: HTMLDivElement | null = null;
  private inspectorEl: HTMLDivElement | null = null;
  private insightsEl: HTMLDivElement | null = null;
  private statsEl: HTMLDivElement | null = null;
  private tooltip: HTMLDivElement | null = null;
  private controlsEl: HTMLDivElement | null = null;

  private fpsSamples: number[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pathFrom: string | null = null;

  constructor(
    private container: HTMLElement,
    private graph: KnowledgeGraph3D,
    private options: HudOptions,
    private theme: Theme,
  ) {
    injectStyles();
    this.root = el('div', 'kg3d-hud');
    this.container.appendChild(this.root);

    const topLeft = el('div', 'kg3d-hud__stack kg3d-hud__stack--tl');
    const topRight = el('div', 'kg3d-hud__stack kg3d-hud__stack--tr');
    const bottomLeft = el('div', 'kg3d-hud__stack kg3d-hud__stack--bl');
    const bottomRight = el('div', 'kg3d-hud__stack kg3d-hud__stack--br');
    this.root.append(topLeft, topRight, bottomLeft, bottomRight);

    if (options.search) topLeft.appendChild(this.buildSearch());
    if (options.insights) topLeft.appendChild(this.buildInsights());
    if (options.controls) topRight.appendChild(this.buildControls());
    if (options.inspector) topRight.appendChild(this.buildInspector());
    if (options.legend) bottomLeft.appendChild(this.buildLegend());
    if (options.stats) bottomRight.appendChild(this.buildStats());

    this.tooltip = el('div', 'kg3d-tooltip');
    this.tooltip.style.opacity = '0';
    this.root.appendChild(this.tooltip);

    this.applyTheme(theme);
    this.refresh();
  }

  /* ------------------------------------------------------------- sections */

  private buildSearch(): HTMLElement {
    const panel = el('div', 'kg3d-panel kg3d-panel--search');
    const field = el('div', 'kg3d-search');
    const icon = el('span', 'kg3d-search__icon');
    icon.innerHTML = SEARCH_ICON;
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'kg3d-search__input';
    input.placeholder = 'Search entities…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    this.searchInput = input;

    field.append(icon, input);
    panel.appendChild(field);

    const results = el('div', 'kg3d-search__results');
    this.searchResults = results;
    panel.appendChild(results);

    input.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      // 120ms is short enough to feel instant, long enough to skip a search per
      // keystroke on a 50k-node client-side scan.
      this.searchTimer = setTimeout(() => void this.runSearch(input.value), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        results.innerHTML = '';
        results.classList.remove('is-open');
      }
    });
    return panel;
  }

  private async runSearch(query: string): Promise<void> {
    const results = this.searchResults;
    if (!results) return;
    if (!query.trim()) {
      results.innerHTML = '';
      results.classList.remove('is-open');
      return;
    }
    const nodes = await this.graph.search(query);
    results.innerHTML = '';
    if (nodes.length === 0) {
      const empty = el('div', 'kg3d-search__empty');
      empty.textContent = 'No matches';
      results.appendChild(empty);
      results.classList.add('is-open');
      return;
    }
    for (const node of nodes.slice(0, 8)) {
      const row = el('button', 'kg3d-search__row');
      const dot = el('span', 'kg3d-dot');
      dot.style.background = this.colorForNode(node);
      const label = el('span', 'kg3d-search__label');
      label.textContent = node.label ?? node.id;
      const type = el('span', 'kg3d-search__type');
      type.textContent = node.type ?? '';
      row.append(dot, label, type);
      row.addEventListener('click', () => {
        this.graph.focus(node.id);
        results.classList.remove('is-open');
      });
      results.appendChild(row);
    }
    results.classList.add('is-open');
  }

  private buildControls(): HTMLElement {
    const panel = el('div', 'kg3d-panel');
    panel.appendChild(sectionTitle('View'));

    // Initial values come from the engine, not from constants: the host may
    // have configured a different encoding and a HUD that disagrees with the
    // picture on screen is worse than no HUD.
    const currentColor =
      this.graph.colorBy.by === 'metric' ? this.graph.colorBy.metric : this.graph.colorBy.by;
    const currentSize =
      this.graph.sizeBy.by === 'metric' ? this.graph.sizeBy.metric : this.graph.sizeBy.by;

    const layoutRow = labelledRow('Layout');
    const layoutSelect = select(
      ['force', 'cluster', 'sphere', 'radial', 'hierarchy', 'grid'],
      this.graph.layout,
      (value) => this.graph.setLayout(value as LayoutName),
    );
    layoutRow.appendChild(layoutSelect);

    const colorRow = labelledRow('Colour');
    const colorSelect = select(
      ['type', 'community', 'pagerank', 'betweenness', 'degree'],
      currentColor,
      (value) => {
        if (value === 'type' || value === 'community') {
          this.graph.setColorBy({ by: value });
        } else {
          this.graph.setColorBy({ by: 'metric', metric: value as MetricName });
        }
      },
    );
    colorRow.appendChild(colorSelect);

    const sizeRow = labelledRow('Size');
    const sizeSelect = select(
      ['weight', 'degree', 'pagerank', 'betweenness', 'constant'],
      currentSize,
      (value) => {
        if (value === 'weight' || value === 'degree' || value === 'constant') {
          this.graph.setSizeBy({ by: value } as never);
        } else {
          this.graph.setSizeBy({ by: 'metric', metric: value as MetricName });
        }
      },
    );
    sizeRow.appendChild(sizeSelect);

    const themeRow = labelledRow('Theme');
    const themeSelect = select(
      ['obsidian', 'nebula', 'slate', 'daylight'],
      this.theme.name,
      (value) => this.graph.setTheme(value as ThemeName),
    );
    themeRow.appendChild(themeSelect);

    const actions = el('div', 'kg3d-actions');
    actions.append(
      button('Fit', () => this.graph.frameAll()),
      button('Reset', () => {
        this.graph.clearFocus();
        this.graph.clearSelection();
        this.graph.frameAll();
      }),
      button('Re-run', () => this.graph.restartLayout()),
    );

    panel.append(layoutRow, colorRow, sizeRow, themeRow, actions);
    this.controlsEl = panel;
    return panel;
  }

  private buildInspector(): HTMLElement {
    const panel = el('div', 'kg3d-panel kg3d-panel--inspector');
    panel.appendChild(sectionTitle('Inspector'));
    const body = el('div', 'kg3d-inspector__body');
    body.innerHTML = '<div class="kg3d-empty">Select a node to inspect it.</div>';
    this.inspectorEl = body;
    panel.appendChild(body);
    return panel;
  }

  private buildInsights(): HTMLElement {
    const panel = el('div', 'kg3d-panel kg3d-panel--insights');
    panel.appendChild(sectionTitle('Structure'));
    const body = el('div', 'kg3d-insights__body');
    this.insightsEl = body;
    panel.appendChild(body);
    return panel;
  }

  private buildLegend(): HTMLElement {
    const panel = el('div', 'kg3d-panel kg3d-panel--legend');
    const body = el('div', 'kg3d-legend');
    this.legendEl = body;
    panel.appendChild(body);
    return panel;
  }

  private buildStats(): HTMLElement {
    const panel = el('div', 'kg3d-stats');
    this.statsEl = panel;
    return panel;
  }

  /* --------------------------------------------------------------- update */

  refresh(): void {
    this.renderLegend();
    this.renderInsights();
  }

  private renderLegend(): void {
    if (!this.legendEl) return;
    const entries = this.graph.getLegend();
    this.legendEl.innerHTML = '';
    if (entries.length === 0) {
      // A continuous encoding gets a ramp, not swatches.
      const ramp = el('div', 'kg3d-legend__ramp');
      const bar = el('div', 'kg3d-legend__bar');
      const labels = el('div', 'kg3d-legend__ramp-labels');
      labels.innerHTML = '<span>low</span><span>high</span>';
      ramp.append(bar, labels);
      this.legendEl.appendChild(ramp);
      return;
    }
    for (const entry of entries) {
      const row = el('button', 'kg3d-legend__row');
      const dot = el('span', 'kg3d-dot');
      dot.style.background = entry.color;
      const label = el('span', 'kg3d-legend__label');
      label.textContent = entry.label;
      const count = el('span', 'kg3d-legend__count');
      count.textContent = entry.count.toLocaleString();
      row.append(dot, label, count);
      row.addEventListener('click', () => {
        // Clicking a legend row isolates that class — the fastest way to answer
        // "where are all the X in this graph".
        const active = row.classList.toggle('is-active');
        for (const sibling of Array.from(this.legendEl?.children ?? [])) {
          if (sibling !== row) sibling.classList.remove('is-active');
        }
        this.graph.filterByTypes(active ? [entry.label] : null);
      });
      this.legendEl.appendChild(row);
    }
  }

  private renderInsights(): void {
    if (!this.insightsEl) return;
    const insights = this.graph.getInsights();
    if (!insights) {
      this.insightsEl.innerHTML = '<div class="kg3d-empty">No analytics available.</div>';
      return;
    }
    const stat = (label: string, value: string) =>
      `<div class="kg3d-stat"><span class="kg3d-stat__value">${value}</span><span class="kg3d-stat__label">${label}</span></div>`;

    const hubs = insights.hubs
      .slice(0, 4)
      .map(
        (h) =>
          `<button class="kg3d-rank" data-id="${escapeAttr(h.id)}"><span class="kg3d-rank__name">${escapeHtml(
            h.label,
          )}</span><span class="kg3d-rank__bar"><i style="width:${(
            (h.score / (insights.hubs[0]?.score || 1)) *
            100
          ).toFixed(1)}%"></i></span></button>`,
      )
      .join('');

    const bridges = insights.bridges
      .slice(0, 4)
      .map(
        (b) =>
          `<button class="kg3d-rank" data-id="${escapeAttr(b.id)}"><span class="kg3d-rank__name">${escapeHtml(
            b.label,
          )}</span><span class="kg3d-rank__bar kg3d-rank__bar--alt"><i style="width:${(
            (b.score / (insights.bridges[0]?.score || 1)) *
            100
          ).toFixed(1)}%"></i></span></button>`,
      )
      .join('');

    this.insightsEl.innerHTML = `
      <div class="kg3d-statrow">
        ${stat('nodes', insights.nodeCount.toLocaleString())}
        ${stat('edges', insights.edgeCount.toLocaleString())}
        ${stat('clusters', String(insights.communities))}
        ${stat('avg degree', insights.averageDegree.toFixed(1))}
      </div>
      <div class="kg3d-subtitle">Most influential<span title="PageRank: importance weighted by the importance of what points at it">?</span></div>
      <div class="kg3d-ranks">${hubs}</div>
      <div class="kg3d-subtitle">Critical connectors<span title="Betweenness: how much of the graph's shortest-path traffic runs through this node">?</span></div>
      <div class="kg3d-ranks">${bridges}</div>
      <div class="kg3d-footnote">
        modularity ${insights.modularity.toFixed(2)} · density ${insights.density.toFixed(4)} ·
        ${insights.components} component${insights.components === 1 ? '' : 's'} · ⌀≈${insights.diameterEstimate}
      </div>
    `;

    for (const btn of Array.from(this.insightsEl.querySelectorAll<HTMLElement>('.kg3d-rank'))) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (id) this.graph.focus(id);
      });
    }
  }

  setSelection(nodes: GraphNode[]): void {
    if (!this.inspectorEl) return;
    if (nodes.length === 0) {
      this.inspectorEl.innerHTML = '<div class="kg3d-empty">Select a node to inspect it.</div>';
      this.pathFrom = null;
      return;
    }
    if (nodes.length > 1) {
      this.inspectorEl.innerHTML = `<div class="kg3d-empty">${nodes.length} nodes selected.</div>`;
      return;
    }
    const node = nodes[0];
    const metrics = this.graph.getNodeMetrics(node.id);
    const neighbors = this.graph.getNeighbors(node.id);

    const metricRows = metrics
      ? `
      <div class="kg3d-kv"><span>degree</span><b>${metrics.degree}</b></div>
      <div class="kg3d-kv"><span>influence</span><b>${(metrics.pagerank * 1000).toFixed(2)}</b></div>
      <div class="kg3d-kv"><span>bridging</span><b>${metrics.betweenness.toFixed(3)}</b></div>
      <div class="kg3d-kv"><span>cluster</span><b>${metrics.community + 1}</b></div>`
      : '';

    const metaRows = Object.entries(node.meta ?? {})
      .slice(0, 6)
      .map(
        ([k, v]) =>
          `<div class="kg3d-kv"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`,
      )
      .join('');

    const neighborChips = neighbors
      .slice(0, 10)
      .map(
        (n) =>
          `<button class="kg3d-chip" data-id="${escapeAttr(n.id)}">${escapeHtml(n.label ?? n.id)}</button>`,
      )
      .join('');

    this.inspectorEl.innerHTML = `
      <div class="kg3d-inspector__head">
        <span class="kg3d-dot" style="background:${this.colorForNode(node)}"></span>
        <div>
          <div class="kg3d-inspector__title">${escapeHtml(node.label ?? node.id)}</div>
          <div class="kg3d-inspector__type">${escapeHtml(node.type ?? 'Node')}</div>
        </div>
      </div>
      ${metricRows}
      ${metaRows}
      <div class="kg3d-subtitle">Connected to ${neighbors.length}</div>
      <div class="kg3d-chips">${neighborChips}</div>
      <div class="kg3d-actions">
        <button class="kg3d-btn" data-action="focus">Focus</button>
        <button class="kg3d-btn" data-action="path">${
          this.pathFrom && this.pathFrom !== node.id ? 'Path to here' : 'Path from here'
        }</button>
      </div>
    `;

    for (const chip of Array.from(this.inspectorEl.querySelectorAll<HTMLElement>('.kg3d-chip'))) {
      chip.addEventListener('click', () => {
        const id = chip.dataset.id;
        if (id) this.graph.select([id]);
      });
    }
    this.inspectorEl
      .querySelector('[data-action="focus"]')
      ?.addEventListener('click', () => this.graph.focus(node.id));
    this.inspectorEl.querySelector('[data-action="path"]')?.addEventListener('click', () => {
      if (this.pathFrom && this.pathFrom !== node.id) {
        const path = this.graph.showPath(this.pathFrom, node.id);
        this.pathFrom = null;
        if (!path) this.flashInspector('No path exists between those nodes.');
      } else {
        this.pathFrom = node.id;
        this.flashInspector('Now select the destination node.');
      }
    });
  }

  private flashInspector(message: string): void {
    if (!this.inspectorEl) return;
    const note = el('div', 'kg3d-note');
    note.textContent = message;
    this.inspectorEl.appendChild(note);
    setTimeout(() => note.remove(), 2600);
  }

  setHovered(node: GraphNode | null, screen: { x: number; y: number }): void {
    if (!this.tooltip) return;
    if (!node) {
      this.tooltip.style.opacity = '0';
      return;
    }
    this.tooltip.innerHTML = `<b>${escapeHtml(node.label ?? node.id)}</b><span>${escapeHtml(
      node.type ?? 'Node',
    )}</span>`;
    this.tooltip.style.transform = `translate(${screen.x + 14}px, ${screen.y + 14}px)`;
    this.tooltip.style.opacity = '1';
  }

  tick(fps: number): void {
    if (!this.statsEl) return;
    this.fpsSamples.push(fps);
    if (this.fpsSamples.length > 20) this.fpsSamples.shift();
    // Only repaint the stat line a few times a second; it is the one HUD
    // element that would otherwise cause layout work every frame.
    if (this.fpsSamples.length % 5 !== 0) return;
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    const insights = this.graph.getInsights();
    this.statsEl.textContent = insights
      ? `${insights.nodeCount.toLocaleString()} nodes · ${insights.edgeCount.toLocaleString()} edges · ${avg.toFixed(0)} fps`
      : `${avg.toFixed(0)} fps`;
  }

  applyTheme(theme: Theme): void {
    this.theme = theme;
    const light = theme.name === 'daylight';
    this.root.classList.toggle('kg3d-hud--light', light);
    this.root.style.setProperty('--kg3d-accent', theme.palette[0]);
    this.root.style.setProperty('--kg3d-accent-2', theme.palette[1]);
    this.refresh();
  }

  private colorForNode(node: GraphNode): string {
    if (node.color) return node.color;
    const types = this.graph.getLegend();
    const entry = types.find((t) => t.label === (node.type ?? 'Node'));
    return entry?.color ?? this.theme.nodeDefault;
  }

  dispose(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.root.remove();
  }
}

/* ------------------------------------------------------------- dom helpers */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  const title = el('div', 'kg3d-panel__title');
  title.textContent = text;
  return title;
}

function labelledRow(label: string): HTMLElement {
  const row = el('label', 'kg3d-row');
  const span = el('span', 'kg3d-row__label');
  span.textContent = label;
  row.appendChild(span);
  return row;
}

function select(values: string[], initial: string, onChange: (value: string) => void): HTMLElement {
  const node = document.createElement('select');
  node.className = 'kg3d-select';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === initial) option.selected = true;
    node.appendChild(option);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function button(label: string, onClick: () => void): HTMLElement {
  const node = el('button', 'kg3d-btn');
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const SEARCH_ICON =
  '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8.5" cy="8.5" r="5.2"/><path d="M12.6 12.6 17 17"/></svg>';

/* ------------------------------------------------------------------ styles */

let stylesInjected = false;

/**
 * Styles ship inline so the library works from a single import. The `styles.css`
 * export exists for apps that prefer to bundle it themselves and drop the
 * runtime injection.
 */
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  if (document.getElementById('kg3d-styles')) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'kg3d-styles';
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

export const HUD_CSS = `
.kg3d-root { position: relative; overflow: hidden; }
.kg3d-hud {
  --kg3d-bg: rgba(12, 16, 26, 0.72);
  --kg3d-border: rgba(255, 255, 255, 0.09);
  --kg3d-text: #dfe6f2;
  --kg3d-muted: #8b98ae;
  --kg3d-accent: #5b8cff;
  --kg3d-accent-2: #3fd8c2;
  position: absolute; inset: 0; pointer-events: none; z-index: 3;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px; color: var(--kg3d-text);
  -webkit-font-smoothing: antialiased;
}
.kg3d-hud--light {
  --kg3d-bg: rgba(255, 255, 255, 0.86);
  --kg3d-border: rgba(15, 23, 38, 0.12);
  --kg3d-text: #1d2431;
  --kg3d-muted: #5d6b80;
}
.kg3d-hud__stack { position: absolute; display: flex; flex-direction: column; gap: 10px; max-width: 300px; }
.kg3d-hud__stack--tl { top: 16px; left: 16px; }
.kg3d-hud__stack--tr { top: 16px; right: 16px; }
.kg3d-hud__stack--bl { bottom: 16px; left: 16px; }
.kg3d-hud__stack--br { bottom: 16px; right: 16px; align-items: flex-end; }

.kg3d-panel {
  pointer-events: auto;
  background: var(--kg3d-bg);
  border: 1px solid var(--kg3d-border);
  border-radius: 12px;
  padding: 12px;
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
  display: flex; flex-direction: column; gap: 9px;
  max-height: 42vh; overflow: auto; scrollbar-width: thin;
}
.kg3d-panel--search { padding: 8px; gap: 6px; }
.kg3d-panel__title {
  font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--kg3d-muted); font-weight: 600;
}
.kg3d-subtitle {
  font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--kg3d-muted); font-weight: 600; margin-top: 4px;
  display: flex; align-items: center; gap: 5px;
}
.kg3d-subtitle span {
  width: 13px; height: 13px; border-radius: 50%; display: inline-grid; place-items: center;
  border: 1px solid var(--kg3d-border); font-size: 9px; cursor: help; color: var(--kg3d-muted);
}

.kg3d-search { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.kg3d-search__icon { color: var(--kg3d-muted); display: flex; }
.kg3d-search__input {
  flex: 1; background: none; border: none; outline: none; color: var(--kg3d-text);
  font-size: 13px; font-family: inherit; min-width: 180px;
}
.kg3d-search__input::placeholder { color: var(--kg3d-muted); }
.kg3d-search__results { display: none; flex-direction: column; gap: 2px; }
.kg3d-search__results.is-open { display: flex; }
.kg3d-search__row, .kg3d-legend__row {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  background: none; border: none; border-radius: 7px; cursor: pointer;
  color: inherit; font: inherit; text-align: left; width: 100%;
}
.kg3d-search__row:hover, .kg3d-legend__row:hover { background: rgba(255,255,255,0.07); }
.kg3d-hud--light .kg3d-search__row:hover, .kg3d-hud--light .kg3d-legend__row:hover { background: rgba(0,0,0,0.05); }
.kg3d-search__label, .kg3d-legend__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kg3d-search__type, .kg3d-legend__count { color: var(--kg3d-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.kg3d-search__empty, .kg3d-empty { color: var(--kg3d-muted); padding: 8px; font-size: 12px; }

.kg3d-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }
.kg3d-legend { display: flex; flex-direction: column; gap: 1px; min-width: 190px; }
.kg3d-legend__row.is-active { background: rgba(255,255,255,0.12); }
.kg3d-legend__ramp { display: flex; flex-direction: column; gap: 4px; min-width: 170px; }
.kg3d-legend__bar {
  height: 8px; border-radius: 4px;
  background: linear-gradient(90deg,#1e3a6e,#2f6fb5,#3fb0c8,#7fe0a8,#f2e06b,#ffb45e);
}
.kg3d-legend__ramp-labels { display: flex; justify-content: space-between; color: var(--kg3d-muted); font-size: 10px; }

.kg3d-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kg3d-row__label { color: var(--kg3d-muted); }
.kg3d-select {
  background: rgba(255,255,255,0.06); color: var(--kg3d-text);
  border: 1px solid var(--kg3d-border); border-radius: 7px;
  padding: 4px 7px; font: inherit; font-size: 11px; cursor: pointer; min-width: 108px;
  text-transform: capitalize;
}
.kg3d-hud--light .kg3d-select { background: rgba(0,0,0,0.04); }
.kg3d-select:focus { outline: 1px solid var(--kg3d-accent); }

.kg3d-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.kg3d-btn, .kg3d-chip {
  pointer-events: auto; background: rgba(255,255,255,0.07); color: var(--kg3d-text);
  border: 1px solid var(--kg3d-border); border-radius: 7px; padding: 5px 10px;
  font: inherit; font-size: 11px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
}
.kg3d-hud--light .kg3d-btn, .kg3d-hud--light .kg3d-chip { background: rgba(0,0,0,0.04); }
.kg3d-btn:hover, .kg3d-chip:hover { background: rgba(255,255,255,0.14); border-color: var(--kg3d-accent); }
.kg3d-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.kg3d-chip { padding: 3px 8px; border-radius: 20px; font-size: 11px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.kg3d-inspector__head { display: flex; align-items: center; gap: 9px; }
.kg3d-inspector__title { font-size: 14px; font-weight: 600; line-height: 1.25; }
.kg3d-inspector__type { color: var(--kg3d-muted); font-size: 11px; }
.kg3d-kv { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; }
.kg3d-kv span { color: var(--kg3d-muted); }
.kg3d-kv b { font-variant-numeric: tabular-nums; font-weight: 600; }
.kg3d-note { color: var(--kg3d-accent-2); font-size: 11px; margin-top: 4px; }

.kg3d-statrow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.kg3d-stat { display: flex; flex-direction: column; gap: 1px; }
.kg3d-stat__value { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.kg3d-stat__label { font-size: 9px; color: var(--kg3d-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.kg3d-ranks { display: flex; flex-direction: column; gap: 3px; }
.kg3d-rank {
  display: grid; grid-template-columns: 1fr 66px; align-items: center; gap: 8px;
  background: none; border: none; padding: 2px 0; cursor: pointer; color: inherit; font: inherit; text-align: left;
}
.kg3d-rank:hover .kg3d-rank__name { color: var(--kg3d-accent); }
.kg3d-rank__name { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kg3d-rank__bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.09); overflow: hidden; }
.kg3d-rank__bar i { display: block; height: 100%; background: var(--kg3d-accent); border-radius: 2px; }
.kg3d-rank__bar--alt i { background: var(--kg3d-accent-2); }
.kg3d-footnote { color: var(--kg3d-muted); font-size: 10px; line-height: 1.5; margin-top: 4px; }

.kg3d-stats {
  pointer-events: none; color: var(--kg3d-muted); font-size: 10.5px;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
  background: var(--kg3d-bg); border: 1px solid var(--kg3d-border);
  padding: 5px 9px; border-radius: 7px; backdrop-filter: blur(12px);
}
.kg3d-tooltip {
  position: absolute; top: 0; left: 0; pointer-events: none;
  background: var(--kg3d-bg); border: 1px solid var(--kg3d-border);
  padding: 6px 9px; border-radius: 8px; display: flex; flex-direction: column; gap: 1px;
  backdrop-filter: blur(14px); transition: opacity 120ms ease; will-change: transform;
  box-shadow: 0 10px 26px rgba(0,0,0,0.3); max-width: 240px;
}
.kg3d-tooltip b { font-size: 12px; font-weight: 600; }
.kg3d-tooltip span { font-size: 10.5px; color: var(--kg3d-muted); }

@media (max-width: 720px) {
  .kg3d-hud__stack { max-width: 44vw; }
  .kg3d-panel { max-height: 34vh; padding: 10px; }
  .kg3d-search__input { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .kg3d-btn, .kg3d-chip, .kg3d-tooltip { transition: none; }
}
`;
