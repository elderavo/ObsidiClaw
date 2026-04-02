---
id: 202604011031
type: permanent
tags:
    - agent_design
    - declarative
    - reinforcement_learning
    - optimization
    - autonomy
    - strategies
workspace: vaultus-sapiens
---
Note title: imperative-v-declarative-agent-design

Note body:
# Imperative v Declarative Agent Design

### Essence
Declarative architecture aligns naturally with reinforcement learning: we define **success conditions** and **reward structures**, not explicit procedural steps. Agents then discover or compose their own strategies for achieving the desired end state.

---
### Core Idea
When we design agents imperatively — prescribing behavior step by step — we risk unintended optimization. The agent may maximize local rewards or reproduce actions that mimic human processes rather than outcomes.

Declarative agent design would focus on expressing *what success looks like*, not *how to achieve it*. By defining the environment, rewards, and sensory inputs clearly, we enable autonomous and creative adaptation.

---
### Key Points
- **Imperative design pits control against autonomy.** It encodes execution, not intent.
- **Declarative design encodes outcomes.** The agent reasons over these constraints.
- Reward design is the bridge — we set the gradient field for learning, not the path.
- Alignment depends on designing observables (sensors) and boundaries (environment) correctly.

---
### Example
Instead of telling an agent:
> "Search for and open the file, then extract the text."

We define:
> *Goal:* Extract textual content from a given source.
> *Reward:* Positive reinforcement when structured text is successfully parsed.
> *Environment:* The agent perceives available file handles.

From there, the agent determines its own optimal behavior.
Of course, we have to be very careful about the actual reward design.

---
### Takeaway
Declarative agent design mirrors reinforcement learning wisdom:
> Define the world, the sense organs, and the score — not the moves.
