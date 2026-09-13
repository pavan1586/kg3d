"""Server-side 3D layout.

Why compute a layout on the server at all, when the client has a perfectly good
force simulation? Three reasons, all about big graphs:

  * every viewer gets the *same* picture, so "the cluster on the left" means the
    same thing in two people's screenshots;
  * a 50k-node layout takes seconds of CPU, and paying that once per graph beats
    paying it once per browser tab;
  * positions can be persisted, so the graph looks the same tomorrow.

Repulsion is split into two passes, because the two things repulsion has to do
have very different cost profiles:

  * **long range** — keep unrelated regions apart. Approximated by repelling
    each node from a fresh random sample of the graph each iteration, scaled by
    n/k. The sample changes every step, so the error averages out over the run
    rather than biasing the final shape.
  * **short range** — stop neighbours collapsing into each other. Computed
    exactly, but only against the other occupants of the node's own cell in a
    uniform grid, which is where collisions actually happen.

The result is O(n·k) per iteration with small constants and no Python-level tree
walk, which is what makes this viable in numpy at all. An exact octree in Python
is roughly two orders of magnitude slower; the client's compiled Barnes-Hut
worker is the right tool above ~25k nodes, and this is the right tool below it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from app.models.graph import GraphData


@dataclass
class LayoutResult:
    ids: list[str]
    positions: np.ndarray  # (n, 3)
    iterations: int
    duration_ms: float
    algorithm: str


def force_layout_3d(
    data: GraphData,
    iterations: int = 200,
    scale: float = 520.0,
    seed: int = 42,
    charge: float = -320.0,
    link_distance: float = 46.0,
    link_strength: float = 0.55,
    gravity: float = 0.035,
    damping: float = 0.86,
    dimensions: int = 3,
) -> LayoutResult:
    started = time.perf_counter()
    ids = [node.id for node in data.nodes]
    n = len(ids)
    if n == 0:
        return LayoutResult([], np.zeros((0, 3)), 0, 0.0, "force3d")

    index = {node_id: i for i, node_id in enumerate(ids)}
    rng = np.random.default_rng(seed)

    # Seed inside a sphere; a cube start biases the final shape toward its corners.
    directions = rng.normal(size=(n, 3))
    directions /= np.linalg.norm(directions, axis=1, keepdims=True) + 1e-9
    radii = np.cbrt(rng.random(n)).reshape(-1, 1)
    positions = directions * radii * (scale * 0.45)
    if dimensions == 2:
        positions[:, 2] = 0.0

    sources: list[int] = []
    targets: list[int] = []
    weights: list[float] = []
    for edge in data.edges:
        s, t = index.get(edge.source), index.get(edge.target)
        if s is None or t is None or s == t:
            continue
        sources.append(s)
        targets.append(t)
        weights.append(float(edge.weight or 1.0))

    src = np.asarray(sources, dtype=np.int64)
    dst = np.asarray(targets, dtype=np.int64)
    w = np.asarray(weights, dtype=np.float64)

    velocities = np.zeros_like(positions)
    alpha = 1.0

    for iteration in range(iterations):
        forces = _repulsion(positions, charge, rng)

        if src.size:
            delta = positions[dst] - positions[src]
            distance = np.linalg.norm(delta, axis=1)
            np.maximum(distance, 1e-4, out=distance)
            displacement = ((distance - link_distance) / distance) * link_strength * w * 0.5
            pull = delta * displacement[:, None]
            np.add.at(forces, src, pull)
            np.add.at(forces, dst, -pull)

        forces -= positions * gravity

        step = min(1.0, alpha * 2.2)
        velocities = (velocities + forces * step) * damping
        # Velocity clamp: without it the first few iterations of a dense graph
        # can throw nodes to infinity before the springs take hold.
        limit = link_distance * 1.5
        np.clip(velocities, -limit, limit, out=velocities)
        positions += velocities
        if dimensions == 2:
            positions[:, 2] *= 0.85
            velocities[:, 2] = 0.0

        alpha *= 0.985
        if alpha < 0.0025:
            iterations = iteration + 1
            break

    positions -= positions.mean(axis=0)
    extent = np.abs(positions).max()
    if extent > 0:
        positions *= scale / extent

    return LayoutResult(
        ids=ids,
        positions=positions,
        iterations=iterations,
        duration_ms=(time.perf_counter() - started) * 1000,
        algorithm="force3d",
    )


def _repulsion(
    positions: np.ndarray,
    charge: float,
    rng: np.random.Generator,
    samples: int = 64,
    max_cell_members: int = 16,
) -> np.ndarray:
    """Sampled long-range plus exact short-range repulsion."""
    n = positions.shape[0]
    forces = np.zeros_like(positions)
    if n < 2:
        return forces

    # ---- long range: every node against a random sample of the graph -------
    k = min(samples, n - 1)
    if k > 0:
        picks = rng.integers(0, n, size=k)
        targets = positions[picks]
        scale = charge * (n / k)
        block = 2048
        for start in range(0, n, block):
            stop = min(start + block, n)
            delta = targets[None, :, :] - positions[start:stop, None, :]
            dist_sq = np.einsum("ijk,ijk->ij", delta, delta) + 0.35
            inv = scale / (dist_sq * np.sqrt(dist_sq))
            forces[start:stop] += np.einsum("ij,ijk->ik", inv, delta)

    # ---- short range: exact, within each grid cell --------------------------
    lo = positions.min(axis=0)
    span = np.maximum(positions.max(axis=0) - lo, 1e-6)
    # Aim for ~8 occupants per cell: enough that real neighbours share a cell,
    # few enough that the padded gather stays small.
    cells_per_axis = int(np.clip(round((n / 8) ** (1 / 3)), 3, 32))
    coords = np.clip((positions - lo) / (span / cells_per_axis), 0, cells_per_axis - 1).astype(
        np.int64
    )
    flat = (coords[:, 0] * cells_per_axis + coords[:, 1]) * cells_per_axis + coords[:, 2]

    order = np.argsort(flat, kind="stable")
    sorted_cells = flat[order]
    unique_cells, inverse, counts = np.unique(sorted_cells, return_inverse=True, return_counts=True)
    if unique_cells.size == n:
        return forces  # every node alone in its cell: nothing to correct

    # Rank of each node inside its cell, so we can build a padded
    # (cell x member) index table in one pass instead of a Python loop.
    first_index = np.repeat(np.cumsum(np.concatenate(([0], counts[:-1]))), counts)
    rank = np.arange(sorted_cells.size) - first_index
    keep = rank < max_cell_members

    table = np.full((unique_cells.size, max_cell_members), -1, dtype=np.int64)
    table[inverse[keep], rank[keep]] = order[keep]

    members = table[inverse]  # (n_sorted, max_cell_members)
    valid = members >= 0
    neighbour_pos = positions[np.where(valid, members, 0)]
    delta = neighbour_pos - positions[order][:, None, :]
    dist_sq = np.einsum("ijk,ijk->ij", delta, delta) + 0.35
    inv = charge / (dist_sq * np.sqrt(dist_sq))
    # Mask out padding and the node's own entry (delta == 0 contributes nothing,
    # but the mask keeps it explicit and avoids relying on that).
    inv = np.where(valid & (members != order[:, None]), inv, 0.0)
    np.add.at(forces, order, np.einsum("ij,ijk->ik", inv, delta))

    return forces


def layered_layout(data: GraphData, scale: float = 520.0) -> LayoutResult:
    """Hierarchical layers from `node.level`, or BFS depth when absent."""
    started = time.perf_counter()
    ids = [node.id for node in data.nodes]
    n = len(ids)
    if n == 0:
        return LayoutResult([], np.zeros((0, 3)), 0, 0.0, "layered")

    levels = np.zeros(n, dtype=np.int64)
    explicit = [node.level for node in data.nodes]
    if any(level is not None for level in explicit):
        levels = np.array([level or 0 for level in explicit], dtype=np.int64)
    else:
        import networkx as nx

        from app.services.analytics import build_networkx

        graph = build_networkx(data)
        if graph.number_of_edges():
            root = max(dict(graph.degree()).items(), key=lambda kv: kv[1])[0]
            depths = nx.single_source_shortest_path_length(graph, root)
            index = {node_id: i for i, node_id in enumerate(ids)}
            for node_id, depth in depths.items():
                levels[index[node_id]] = depth

    positions = np.zeros((n, 3))
    unique_levels = sorted(set(levels.tolist()))
    gap = (scale * 1.6) / max(1, len(unique_levels) - 1 or 1)
    top = ((len(unique_levels) - 1) * gap) / 2

    for order, level in enumerate(unique_levels):
        members = np.flatnonzero(levels == level)
        count = members.size
        ring = max(40.0, np.sqrt(count) * 26.0)
        # Golden-angle spiral: even spacing inside the layer with no visible rings.
        angles = np.arange(count) * 2.399963
        radii = ring * np.sqrt((np.arange(count) + 0.5) / max(1, count))
        positions[members, 0] = np.cos(angles) * radii
        positions[members, 1] = top - order * gap
        positions[members, 2] = np.sin(angles) * radii

    return LayoutResult(
        ids=ids,
        positions=positions,
        iterations=1,
        duration_ms=(time.perf_counter() - started) * 1000,
        algorithm="layered",
    )


def apply_positions(data: GraphData, layout: LayoutResult) -> GraphData:
    index = {node_id: i for i, node_id in enumerate(layout.ids)}
    for node in data.nodes:
        i = index.get(node.id)
        if i is None:
            continue
        node.x, node.y, node.z = (float(v) for v in layout.positions[i])
    return data
