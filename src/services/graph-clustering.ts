import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { executeGraphTraversal, type GraphEntityRef, type GraphResult } from "@/services/graph-explorer";

export type GraphClusterMode = "connected_components" | "entity_type";
export type GraphCluster = {
  id: string;
  label: string;
  nodeIds: string[];
  edgeIds: string[];
  entityTypes: string[];
};
export type ClusteredGraphResult = GraphResult & {
  mode: GraphClusterMode;
  clusters: GraphCluster[];
  layout: Array<{ nodeId: string; x: number; y: number; clusterId: string }>;
};

const key = (value: { type: string; id: string }) => `${value.type}:${value.id}`;

function byEntityType(graph: GraphResult): GraphCluster[] {
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) groups.set(node.type, [...(groups.get(node.type) ?? []), key(node)]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, nodeIds]) => {
    const members = new Set(nodeIds);
    return {
      id: `type-${type}`,
      label: type.replaceAll("_", " "),
      nodeIds: [...nodeIds].sort(),
      edgeIds: graph.edges.filter((edge) => members.has(key(edge.source)) && members.has(key(edge.target))).map((edge) => edge.id).sort(),
      entityTypes: [type],
    };
  });
}

function connected(graph: GraphResult): GraphCluster[] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) adjacency.set(key(node), new Set());
  for (const edge of graph.edges) {
    adjacency.get(key(edge.source))?.add(key(edge.target));
    adjacency.get(key(edge.target))?.add(key(edge.source));
  }
  const visited = new Set<string>();
  const clusters: GraphCluster[] = [];
  for (const node of graph.nodes.map(key).sort()) {
    if (visited.has(node)) continue;
    const queue = [node];
    const members: string[] = [];
    visited.add(node);
    while (queue.length) {
      const current = queue.shift()!;
      members.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
    const memberSet = new Set(members);
    clusters.push({
      id: `component-${clusters.length + 1}`,
      label: `Connected group ${clusters.length + 1}`,
      nodeIds: members.sort(),
      edgeIds: graph.edges.filter((edge) => memberSet.has(key(edge.source)) && memberSet.has(key(edge.target))).map((edge) => edge.id).sort(),
      entityTypes: [...new Set(members.map((id) => id.split(":", 1)[0]!))].sort(),
    });
  }
  return clusters;
}

function layout(clusters: GraphCluster[]) {
  return clusters.flatMap((cluster, clusterIndex) => cluster.nodeIds.map((nodeId, nodeIndex) => ({
    nodeId,
    clusterId: cluster.id,
    x: (clusterIndex % 4) * 900 + (nodeIndex % 5) * 160,
    y: Math.floor(clusterIndex / 4) * 700 + Math.floor(nodeIndex / 5) * 120,
  })));
}

export async function executeClusteredGraph(
  input: {
    workspaceId: string;
    projectId: string;
    viewId?: string;
    rootEntities?: GraphEntityRef[];
    filters?: Record<string, unknown>;
    traversal?: Record<string, unknown>;
    mode?: GraphClusterMode;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<ClusteredGraphResult> {
  const graph = await executeGraphTraversal(input, principalId, pool);
  const mode = input.mode ?? "connected_components";
  const clusters = mode === "entity_type" ? byEntityType(graph) : connected(graph);
  return { ...graph, mode, clusters, layout: layout(clusters) };
}
