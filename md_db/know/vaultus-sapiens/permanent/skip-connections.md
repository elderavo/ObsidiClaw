---
id: 6
title: Skip Connections
type: permanent
tags:
    - skip_connections
    - neural_networks
    - training
    - layers
workspace: vaultus-sapiens
---
# Skip Connections

A **skip connection**, or **residual connection**, is a neural network architecture pattern in which the input to a layer or block is added to that layer's output:

```text
output = input + F(input)
```

where `F(input)` is the transformation computed by the layer or subnetwork.

This makes the output an **enrichment** of the input rather than a complete replacement. Instead of forcing a layer to construct an entirely new representation from scratch, the layer only has to learn what should be **added** to the existing representation.

This is the **primary benefit** of residual connections: they make the skipped layer or subnetwork easier to train, because it only needs to learn what needs to get added to the input, instead of having to learn to retain the input structure AND add useful information.

Residual connections also have an important **secondary benefit**: because the input is preserved in the output, later layers receive the prior representation plus the update, which helps useful signal survive through deep networks instead of being overwritten at every stage.

This is especially important in very deep neural networks. As depth increases, the **gradient** can shrink during backpropagation (the vanishing gradient problem), making early layers difficult to train. Skip connections help by creating a direct path for both:
- the forward signal
- the backward learning signal

In transformers, residual connections are used around both the attention sublayer and the FFN sublayer. This allows token representations to accumulate context and transformation gradually, while preserving the incoming representation at each stage.
