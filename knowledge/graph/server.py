"""JSON-RPC stdio server — entry point for the TS subprocess bridge.

Reads newline-delimited JSON from stdin, dispatches to KnowledgeGraphEngine,
writes responses to stdout. stderr is reserved for Python logging.

Handlers run synchronously in the main thread — the TS bridge serializes
requests via await, and stdin buffers any that arrive during a long-running
handler. This avoids the deadlock risk of ThreadPoolExecutor + lock
inversion between engine and stdout locks.
"""

from __future__ import annotations

import logging
import sys
import traceback
from dataclasses import asdict
from typing import Any

from .engine import KnowledgeGraphEngine
from .protocol import RpcError, RpcRequest, RpcResponse, parse_request, send_response, send_notification

# Configure logging to stderr (never stdout — that's the RPC channel)
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[knowledge_graph] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Handler registry
# ---------------------------------------------------------------------------

engine = KnowledgeGraphEngine()


def handle_initialize(params: dict[str, Any]) -> dict[str, Any]:
    # ollama_host and embed_model are optional — env vars take precedence
    kwargs: dict[str, Any] = {}
    if "ollama_host" in params:
        kwargs["ollama_host"] = params["ollama_host"]
    if "embed_model" in params:
        kwargs["embed_model"] = params["embed_model"]

    return engine.initialize(
        md_db_path=params["md_db_path"],
        db_dir=params["db_dir"],
        top_k=params.get("top_k", 8),
        **kwargs,
    )


def handle_retrieve(params: dict[str, Any]) -> dict[str, Any]:
    return engine.retrieve(
        query=params["query"],
        top_k=params.get("top_k"),
        workspace=params.get("workspace"),
    )


def handle_get_note_content(params: dict[str, Any]) -> dict[str, Any]:
    body = engine.get_note_content(params["relative_path"])
    return {"body": body}


def handle_reindex(params: dict[str, Any]) -> dict[str, Any]:
    return engine.reindex()


def handle_incremental_update(params: dict[str, Any]) -> dict[str, Any]:
    changed_paths = params.get("changed_paths", [])
    total = len(changed_paths)

    def progress_cb(done: int, _total: int) -> None:
        send_notification({"type": "index_progress", "done": done, "total": _total})

    return engine.incremental_update(
        changed_paths=changed_paths,
        deleted_paths=params.get("deleted_paths", []),
        progress_cb=progress_cb if total > 0 else None,
    )


def handle_build_prune_clusters(params: dict[str, Any]) -> dict[str, Any]:
    from .pruner import build_prune_clusters
    from .models import PruneConfig

    config = PruneConfig(
        similarity_threshold=params.get("similarity_threshold", 0.85),
        max_neighbors_per_note=params.get("max_neighbors", 10),
        min_cluster_size=params.get("min_cluster_size", 2),
        include_note_types=params.get("include_types", ["concept", "tool"]),
        exclude_tags=params.get("exclude_tags", []),
    )
    clusters = build_prune_clusters(
        config=config,
        index=engine.index,
        embed_model=engine.embed_model,
        parsed_notes=engine._parsed_notes,
    )
    return {"clusters": [_cluster_to_dict(c) for c in clusters]}


def handle_get_graph_stats(params: dict[str, Any]) -> dict[str, Any]:
    return engine.get_graph_stats()


def handle_find_path(params: dict[str, Any]) -> dict[str, Any]:
    return engine.find_path(
        start_query=params["start"],
        end_query=params["end"],
        edge_types=params.get("edge_types"),
        max_depth=params.get("max_depth", 8),
    )


def handle_shutdown(params: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True}


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

HANDLERS: dict[str, Any] = {
    "initialize": handle_initialize,
    "retrieve": handle_retrieve,
    "get_note_content": handle_get_note_content,
    "reindex": handle_reindex,
    "incremental_update": handle_incremental_update,
    "build_prune_clusters": handle_build_prune_clusters,
    "get_graph_stats": handle_get_graph_stats,
    "find_path": handle_find_path,
    "shutdown": handle_shutdown,
}


# ---------------------------------------------------------------------------
# Server loop
# ---------------------------------------------------------------------------


def run_server(standalone: bool = False) -> None:
    """Run the JSON-RPC stdio loop.

    Handlers run synchronously in the main thread. This avoids lock
    inversion deadlocks between engine access and stdout writes (e.g.
    progress notifications sent during incremental_update). The stdin
    buffer naturally queues any requests that arrive mid-handler.
    """
    log.info("Knowledge graph server starting (standalone=%s)", standalone)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = parse_request(line)
        except Exception as exc:
            log.error("Failed to parse request: %s", exc)
            continue

        if standalone:
            log.info("→ %s(%s)", req.method, req.params)

        handler = HANDLERS.get(req.method)
        if handler is None:
            send_response(RpcError(id=req.id, code=-1, message=f"Unknown method: {req.method}"))
            continue

        try:
            result = handler(req.params)
            send_response(RpcResponse(id=req.id, result=result))
        except Exception as exc:
            tb = traceback.format_exc()
            log.error("Handler %s failed:\n%s", req.method, tb)
            send_response(RpcError(id=req.id, code=-1, message=str(exc)))

        if req.method == "shutdown":
            log.info("Shutdown requested, exiting")
            break

    log.info("Server exiting")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cluster_to_dict(cluster: Any) -> dict[str, Any]:
    """Convert a PruneCluster dataclass to a JSON-serializable dict."""
    from dataclasses import asdict

    return {
        "clusterId": cluster.cluster_id,
        "representativeNoteId": cluster.representative_note_id,
        "members": [
            {
                "noteId": m.note_id,
                "similarity": m.similarity,
                "isRepresentative": m.is_representative,
                "status": m.status,
            }
            for m in cluster.members
        ],
        "stats": {
            "size": cluster.stats.size,
            "maxSimilarity": cluster.stats.max_similarity,
            "minSimilarity": cluster.stats.min_similarity,
            "avgSimilarity": cluster.stats.avg_similarity,
        },
    }
