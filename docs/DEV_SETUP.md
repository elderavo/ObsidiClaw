# Dev Setup

This repo is a hybrid:

- **TypeScript/Node**: orchestration, MCP server, logging, formatting.
- **Python** (`knowledge/graph/`): indexing + retrieval engine, exposed to TS via a long-lived JSON-RPC subprocess.

## Prereqs

- Node.js 20+
- Python 3.11+

## Install (Node)

```bash
npm ci
```

## Install (Python)

### Option A: pip (recommended for CI / quick setup)

```bash
python -m pip install -r knowledge/graph/requirements.txt
```

### Option B: conda (recommended for longer-lived local envs)

```bash
conda env create -f knowledge/graph/environment.yml
conda run -n obsidiclaw python -c "import sys; print(sys.executable)"
```

## Tell TS which Python to use (optional)

The TS bridge caches the resolved Python executable in `.obsidi-claw/.python_path`.

If you’re using `pip` (no conda env), you can set it manually:

```bash
mkdir -p .obsidi-claw
python -c "import sys; print(sys.executable)" > .obsidi-claw/.python_path
```

## Run

### Pi TUI

```bash
pi
```

### Headless MCP server (no TUI)

```bash
npx tsx entry/run-mcp.ts
```

## CI / smoke-test mode (no Ollama required)

To avoid any embedding/LLM calls during retrieval:

- Set `OBSIDI_EMBED_PROVIDER=local` (disables vector embeddings).
- Set `OBSIDI_CONTEXT_REVIEW=0` (disables the TS-side context reviewer).

This mode is what the CI smoke test uses to validate the end-to-end TS↔Python subprocess wiring.
