---
id: 2
type: permanent
tags:
    - transformer
workspace: vaultus-sapiens
---
# FFN (Transformer)

Each transformer block contains two sublayers: an attention sublayer and a Feed-Forward Network (FFN). The FFN is where the model applies transformations to each token — if attention handles *routing* (which tokens matter to which), the FFN handles *thinking* (what to do with the result). They always come in a pair.

The FFN is a 2-layer MLP — shallow, but wide. It expands to 4× the model dimension in the hidden layer, then contracts back:

`d_model → 4×d_model → d_model`

So for a model with embedding dimension 1536: `1536 → 6144 → 1536`

The nonlinearity (activation) between the two layers is typically **GeLU** — a smooth, continuously differentiable alternative to ReLU that also allows small negative activations through rather than hard-zeroing them. This improves gradient flow during training.

The FFN operates on each token **independently** — no cross-token interaction happens here. That's attention's job. The FFN just processes what attention already aggregated. The FFN is also thought to be where **factual and associative knowledge is stored** in large models — attention routes, FFN remembers. It essentially "massages" tokens from input into output.

## Transformer Blocks by Model

| Release Date | Parameters (B) | Model | Blocks |
|---|---|---|---|
| 2019-11 | 0.8 | GPT-2 Small | 12 |
| 2020-02 | 1.5 | GPT-2 XL | 48 |
| 2023-05 | 175 | GPT-3 (175B) | 96 |
| 2023-07 | 8 | LLaMA 3 8B | 32 |
| 2023-07 | 70 | LLaMA 3 70B | 80 |
| 2023-07 | 405 | LLaMA 3 405B | 126 |
| Proprietary | — | GPT-4 / Claude / Gemini | ~96–128+ |

This table shows model names and how many attention+FFN blocks each has. Generally, the greater number, the more complex the thinking.


## Links:

[[multi-layer-perceptron]]
