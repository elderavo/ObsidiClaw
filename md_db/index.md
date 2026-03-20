---
id: 1
time_created: 
last_edited:
tags:
etc:
---

# Index

this is the entry point for the knowledge graph. It's made of linked markdown files. The context engine will traverse the files and pull the markdown files it thinks are the most relevant to the prompt, as well as what tools could provide the most useful info. It provides the output of the tool run and the markdown as context to the pi_agent. 

The directory structure is flat, but the linking creates a graph structure.

'concepts' is NOT for fact storage. If you want to store an ephemeral fact like a network configuration, write a tool to retrieve the current value of that fact instead of hardcoding the fact. 'concepts' is intended to store insight. 

 

## tools
tools/network
[[network]]
tools/bash_core
[[bash_core]]
tools/web_search
[[web_search]]
tools/ask_user
[[ask_user]]

## concepts
concepts/failure_modes
[[failure_modes]]
concepts/best_practices
[[best_practices]]
concepts/preferences
[[preferences]]
concepts/heuristics
[[heuristics]]