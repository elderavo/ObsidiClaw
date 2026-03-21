/**
 * Graph builder with cycle detection and prevention.
 *
 * Builds a directed graph from wikilinks while detecting and handling
 * circular references to prevent infinite loops during traversal.
 */
import type { WikiLink } from './parser.js';
export interface GraphNode {
    /** File identifier (note_id/path) */
    id: string;
    /** Files this node links to (outgoing edges) */
    outgoing: Set<string>;
    /** Files that link to this node (incoming edges) */
    incoming: Set<string>;
    /** Detailed link information for outgoing links */
    outgoingLinks: WikiLink[];
    /** Whether this node was visited during current cycle detection pass */
    visited?: boolean;
    /** Whether this node is in the current path during cycle detection */
    inPath?: boolean;
}
export interface CycleInfo {
    /** The cycle path as an array of node IDs */
    cycle: string[];
    /** The link that would complete the cycle */
    triggerLink: WikiLink;
}
export interface GraphStats {
    /** Total number of nodes */
    nodeCount: number;
    /** Total number of edges */
    edgeCount: number;
    /** Number of nodes with no incoming links */
    orphanCount: number;
    /** Number of nodes with no outgoing links */
    leafCount: number;
    /** Detected cycles */
    cycles: CycleInfo[];
}
/**
 * Core graph data structure with cycle detection capabilities.
 */
export declare class LinkGraph {
    private nodes;
    private detectedCycles;
    /**
     * Add a node to the graph if it doesn't exist.
     */
    addNode(nodeId: string): void;
    /**
     * Add a directed edge with cycle detection.
     * Returns true if edge was added, false if it would create a cycle.
     */
    addEdge(fromId: string, toId: string, linkInfo: WikiLink): boolean;
    /**
     * Remove an edge between two nodes.
     */
    removeEdge(fromId: string, toId: string): boolean;
    /**
     * Replace all outgoing edges from a node.
     * Used during file updates to refresh links.
     */
    replaceOutgoingEdges(fromId: string, newLinks: WikiLink[]): void;
    /**
     * Get a node by ID.
     */
    getNode(nodeId: string): GraphNode | undefined;
    /**
     * Get all nodes that this node links to (outgoing edges).
     */
    getOutgoingNodes(nodeId: string): string[];
    /**
     * Get all nodes that link to this node (incoming edges).
     */
    getIncomingNodes(nodeId: string): string[];
    /**
     * Get detailed link information for outgoing links from a node.
     */
    getOutgoingLinks(nodeId: string): WikiLink[];
    /**
     * Get all node IDs in the graph.
     */
    getAllNodeIds(): string[];
    /**
     * Check if adding an edge would create a cycle using DFS.
     */
    private wouldCreateCycle;
    /**
     * Check if one node can reach another via directed edges (DFS).
     */
    private canReach;
    /**
     * Find the actual cycle path that would be created.
     */
    private findCyclePath;
    /**
     * Get comprehensive statistics about the graph.
     */
    getStats(): GraphStats;
    /**
     * Clear all detected cycles (useful after resolving cycle issues).
     */
    clearDetectedCycles(): void;
    /**
     * Remove a node and all its edges from the graph.
     */
    removeNode(nodeId: string): boolean;
}
//# sourceMappingURL=graph_builder.d.ts.map