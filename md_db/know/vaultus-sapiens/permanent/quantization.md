---
id: 5
title: Quantization
type: permanent
tags:
    - quantization
    - precision_reduction
    - selective_precision
    - memory_efficiency
    - inference_acceleration
    - model_compression
    - weight_quantization
    - activation_quantization
workspace: vaultus-sapiens
---
# Quantization

Quantization is the practice of selectively reducing the precision of model weights and sometimes activations to a lower-precision numeric format in order to save memory, reduce bandwidth, and often speed up inference.

Example: quantizing from FP64 weights to FP16 gives a 4x memory reduction, and in many practical cases does not dramatically impact model output quality.

The reduction is selective: some parts of a model are often kept at higher precision because they are more sensitive, such as embeddings, output/decoding layers, normalization-related values, scaling metadata, and accumulations.

Importantly, quantization is not just blindly rounding every value into a tiny fixed range. That would badly clip large values, round many small values to zero, and lose too much information.

Instead, quantization methods usually group weights with similar value distributions and represent them using low-bit codes plus metadata such as per-group or per-block scales and sometimes offsets / zero-points. This preserves much more information while still reducing storage cost.

Quantization is approximate compression of tensors, not naive truncation.
