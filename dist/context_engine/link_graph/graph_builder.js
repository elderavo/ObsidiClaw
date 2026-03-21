/**
 * Graph builder with cycle detection and prevention.
 *
 * Builds a directed graph from wikilinks while detecting and handling
 * circular references to prevent infinite loops during traversal.
 */
/**
 * Core graph data structure with cycle detection capabilities.
 */
export class LinkGraph {
    nodes = new Map();
    detectedCycles = [];
    /**
     * Add a node to the graph if it doesn't exist.
     */
    addNode(nodeId) {
        if (!this.nodes.has(nodeId)) {
            this.nodes.set(nodeId, {
                id: nodeId,
                outgoing: new Set(),
                incoming: new Set(),
                outgoingLinks: []
            });
        }
    }
    /**
     * Add a directed edge with cycle detection.
     * Returns true if edge was added, false if it would create a cycle.
     */
    addEdge(fromId, toId, linkInfo) {
        this.addNode(fromId);
        this.addNode(toId);
        // Check if this edge would create a cycle
        if (this.wouldCreateCycle(fromId, toId)) {
            const cycle = this.findCyclePath(fromId, toId);
            this.detectedCycles.push({
                cycle: cycle || [fromId, toId],
                triggerLink: linkInfo
            });
            console.warn(`[link-graph] Cycle detected: ${fromId} -> ${toId} would complete cycle`);
            return false;
        }
        const fromNode = this.nodes.get(fromId);
        const toNode = this.nodes.get(toId);
        // Add the edge
        fromNode.outgoing.add(toId);
        toNode.incoming.add(fromId);
        fromNode.outgoingLinks.push(linkInfo);
        return true;
    }
    /**
     * Remove an edge between two nodes.
     */
    removeEdge(fromId, toId) {
        const fromNode = this.nodes.get(fromId);
        const toNode = this.nodes.get(toId);
        if (!fromNode || !toNode) {
            return false;
        }
        const wasRemoved = fromNode.outgoing.delete(toId) && toNode.incoming.delete(fromId);
        if (wasRemoved) {
            // Remove corresponding link info
            fromNode.outgoingLinks = fromNode.outgoingLinks.filter(link => link.target !== toId);
        }
        return wasRemoved;
    }
    /**
     * Replace all outgoing edges from a node.
     * Used during file updates to refresh links.
     */
    replaceOutgoingEdges(fromId, newLinks) {
        this.addNode(fromId);
        const fromNode = this.nodes.get(fromId);
        // Remove old outgoing edges
        for (const toId of fromNode.outgoing) {
            const toNode = this.nodes.get(toId);
            if (toNode) {
                toNode.incoming.delete(fromId);
            }
        }
        // Clear and rebuild outgoing edges
        fromNode.outgoing.clear();
        fromNode.outgoingLinks = [];
        // Add new edges with cycle detection
        for (const link of newLinks) {
            this.addEdge(fromId, link.target, link);
        }
    }
    /**
     * Get a node by ID.
     */
    getNode(nodeId) {
        return this.nodes.get(nodeId);
    }
    /**
     * Get all nodes that this node links to (outgoing edges).
     */
    getOutgoingNodes(nodeId) {
        const node = this.nodes.get(nodeId);
        return node ? [...node.outgoing] : [];
    }
    /**
     * Get all nodes that link to this node (incoming edges).
     */
    getIncomingNodes(nodeId) {
        const node = this.nodes.get(nodeId);
        return node ? [...node.incoming] : [];
    }
    /**
     * Get detailed link information for outgoing links from a node.
     */
    getOutgoingLinks(nodeId) {
        const node = this.nodes.get(nodeId);
        return node ? [...node.outgoingLinks] : [];
    }
    /**
     * Get all node IDs in the graph.
     */
    getAllNodeIds() {
        return [...this.nodes.keys()];
    }
    /**
     * Check if adding an edge would create a cycle using DFS.
     */
    wouldCreateCycle(fromId, toId) {
        // If toId can reach fromId, then fromId -> toId would create a cycle
        return this.canReach(toId, fromId);
    }
    /**
     * Check if one node can reach another via directed edges (DFS).
     */
    canReach(startId, targetId) {
        if (startId === targetId) {
            return true;
        }
        const visited = new Set();
        const stack = [startId];
        while (stack.length > 0) {
            const currentId = stack.pop();
            if (visited.has(currentId)) {
                continue;
            }
            visited.add(currentId);
            const current = this.nodes.get(currentId);
            if (!current) {
                continue;
            }
            for (const neighborId of current.outgoing) {
                if (neighborId === targetId) {
                    return true;
                }
                if (!visited.has(neighborId)) {
                    stack.push(neighborId);
                }
            }
        }
        return false;
    }
    /**
     * Find the actual cycle path that would be created.
     */
    findCyclePath(fromId, toId) {
        const path = [];
        const visited = new Set();
        const dfs = (nodeId) => {
            if (path.includes(nodeId)) {
                // Found cycle, return path from this point
                const cycleStart = path.indexOf(nodeId);
                return true;
            }
            if (visited.has(nodeId)) {
                return false;
            }
            visited.add(nodeId);
            path.push(nodeId);
            const node = this.nodes.get(nodeId);
            if (node) {
                for (const neighborId of node.outgoing) {
                    if (dfs(neighborId)) {
                        return true;
                    }
                }
            }
            path.pop();
            return false;
        };
        if (dfs(toId)) {
            path.push(fromId); // Complete the cycle
            return path;
        }
        return null;
    }
    /**
     * Get comprehensive statistics about the graph.
     */
    getStats() {
        const nodeCount = this.nodes.size;
        let edgeCount = 0;
        let orphanCount = 0;
        let leafCount = 0;
        for (const node of this.nodes.values()) {
            edgeCount += node.outgoing.size;
            if (node.incoming.size === 0) {
                orphanCount++;
            }
            if (node.outgoing.size === 0) {
                leafCount++;
            }
        }
        return {
            nodeCount,
            edgeCount,
            orphanCount,
            leafCount,
            cycles: [...this.detectedCycles]
        };
    }
    /**
     * Clear all detected cycles (useful after resolving cycle issues).
     */
    clearDetectedCycles() {
        this.detectedCycles = [];
    }
    /**
     * Remove a node and all its edges from the graph.
     */
    removeNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            return false;
        }
        // Remove incoming edges to this node
        for (const incomingId of node.incoming) {
            const incomingNode = this.nodes.get(incomingId);
            if (incomingNode) {
                incomingNode.outgoing.delete(nodeId);
                incomingNode.outgoingLinks = incomingNode.outgoingLinks.filter(link => link.target !== nodeId);
            }
        }
        // Remove outgoing edges from this node
        for (const outgoingId of node.outgoing) {
            const outgoingNode = this.nodes.get(outgoingId);
            if (outgoingNode) {
                outgoingNode.incoming.delete(nodeId);
            }
        }
        this.nodes.delete(nodeId);
        return true;
    }
}
//# sourceMappingURL=graph_builder.js.map