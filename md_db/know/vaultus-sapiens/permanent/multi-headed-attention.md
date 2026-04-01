---
id: 3
title: Multi-Headed Attention
type: permanent
tags:
    - multi_headed_attention
    - attention_mechanism
    - transformer
    - neural_networks
workspace: vaultus-sapiens
---
# Multi-Headed Attention

Multi-Head Attention addresses the problem of linguistic complexity — a single token may be doing double or triple duty in the semantic interpretation of a sentence (coreference, syntax, semantics simultaneously). A single attention head can only attend to one type of relationship at a time, defined by its W_Q, W_K, W_V weights applied per token.

MHA solves this by splitting the attention layer into **h parallel heads**, each of approximate dimension `d_model / h`:

```
head_1 = Attention(X·W_Q1, X·W_K1, X·W_V1)
head_2 = Attention(X·W_Q2, X·W_K2, X·W_V2)
...
head_h = Attention(X·W_Qh, X·W_Kh, X·W_Vh)
```

During training, each head learns to attend to different types of relationships — syntax, coreference, positional proximity, etc. This specialisation is not programmed; it emerges from training. The outputs of all heads are concatenated and projected back to `d_model` via a final weight matrix W_O:

```
output = concat(head_1, ..., head_h) · W_O
```

`W_O` is a 1-layer MLP that recombines ("mixes", roughly) the multiple heads attention.
****
The total parameter count is roughly equivalent to one full-dimension attention — you get richer, multi-relational attention at the same cost.

## Into the FFN

The MHA output is then folded back into the token's embedding via a **residual connection**, then normalised:

```
x = x + MHA(x)      ← attention output added back in (same dimension: d_model)
x = LayerNorm(x)
x = x + FFN(x)      ← FFN output added back in
x = LayerNorm(x)
```

By the time a token enters the FFN, it's a single enriched `d_model`-dimensional vector carrying attended context from the rest of the sequence.

## Key Properties

- **Dense** — all heads run on every token, every forward pass. No routing, no skipping. (Contrast: MoE, which applies sparse routing to FFN experts.)
- **Residual connections** preserve the original token signal while attention adds context on top
- **W_O** is what glues the specialized head outputs back into one coherent representation

