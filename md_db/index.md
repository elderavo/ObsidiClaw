---
id:
type: index
created:
updated:
---


# Index

this is the entry point for the knowledge graph. It's made of linked markdown files. The context engine will traverse the files and pull the markdown files it thinks are the most relevant to the prompt, as well as what tools could provide the most useful info. It provides the output of the tool run and the markdown as context to the pi_agent. 

The directory structure is flat, but the linking creates a graph structure.

'concepts' is NOT for fact storage. If you want to store an ephemeral fact like a network configuration, write a tool to retrieve the current value of that fact instead of hardcoding the fact. 'concepts' is intended to store insight. 
 

## tools
[[tools]]

## concepts
[[concepts]]

## rules
[[NEVERs]]
[[best_practices]]

## self_knowledge
[[obsidiclaw]]