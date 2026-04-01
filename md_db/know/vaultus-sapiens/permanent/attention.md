---
id: 1
title: Attention (Transformer)
type: permanent
tags:
    - attention
    - transformer
workspace: vaultus-sapiens
---
# Attention (Transformers)

Attention is a key mechanism by which transformers handle nuance. During training, a model learns that certain tokens influence others heavily — it learns to "attend" strongly to that token when another is present. This is accomplished via three shared weight matrices — Q, K, and V — which project every token into three per-token vectors:

- **Query** — what this token is looking for from other tokens
- **Key** — what this token contains that other tokens might be looking for
- **Value** — what this token contributes if another token attends to it

The process is essentially updating tokens features in embedding space, based on what other tokens were in a sequence. $Q$ and $K$ describe how the tokens decide whether or not they should attend to each other, and $V$ is which features (roughly) from the attended-to token get integrated into the updated token.

Q, K, and V are three separate vectors created from the same input tensor by multiplying it by three different learned weight matrices. They are different "views" of the same token sequence: one for asking, one for matching, and one for sending information.


 1. Start with one sequence tensor $X$
 2. Make three transformed copies: $Q, K, V$
 3. Use Q and K to compute who attends to whom ($QK^T$)
 4. Use those attention weights on $V$ to compute what gets passed
 5. Add that result back to $X$

## Links:
[[multi-headed-attention]]
