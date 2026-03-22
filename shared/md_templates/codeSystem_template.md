---
type: concept
name: <Subsystem Name>
root: <folder or logical root>
contains:
  - [[<file_note: file1>]]
  - [[<file_note: file2>]]

depends_on:
  - [[<index_note: other subsystem>]]

patterns:
  - [[<pattern_note>]]

last_verified: <YYYY-MM-DD>
---

# <Subsystem Name>

## Purpose
<What this subsystem does in the overall architecture>

## Boundaries
- Owns: <what it is responsible for>
- Does NOT own: <what is explicitly out of scope>

## Core Components
- [[<file_note: file1>]] — <role>
- [[<file_note: file2>]] — <role>

## Internal Flow
- <high-level flow across files>
  e.g. `orchestrator → context_engine → logger`

## External Interfaces
- Input: <what enters subsystem>
- Output: <what leaves subsystem>

## Key Invariants
- <rules that must always hold>

## Design Philosophy
- <why it’s structured this way (short, not essay)>

## Failure Modes
- <how this subsystem fails>

## Change Impact Map
- Changing <component> affects:
  - [[<file_note: ...>]]
  - [[<index_note: ...>]]