---
type: concept
path: <relative/path/to/file>
language: <ts|py|...>
module: [[<Subsystem Index Note>]]

imports:
  - [[<file_note: dep1>]]
  - [[<file_note: dep2>]]

imported_by:
  - [[<file_note: caller1>]]

exports:
  - <function|class name>
  - <function|class name>

patterns:
  - [[<pattern_note: e.g. Factory Pattern>]]

last_verified: <YYYY-MM-DD>
---

# <filename>

## Purpose
<1–2 sentences: what this file is responsible for in the system>

## Responsibilities
- <specific responsibility 1>
- <specific responsibility 2>

## Key Abstractions
- <Class/Function>: <what it represents in system terms>

## Control Flow (if relevant)
- <entrypoint> → <major steps> → <outputs/effects>

## Dependencies (Why they exist)
- [[<file_note: dep1>]]: <why this dependency is required>
- [[<file_note: dep2>]]: <why this dependency is required>

## Design Notes
- <non-obvious decisions>
- <constraints or tradeoffs>

## Known Weaknesses
- <where this breaks / tech debt>

## Change Triggers
- If <X changes>, this file likely needs update