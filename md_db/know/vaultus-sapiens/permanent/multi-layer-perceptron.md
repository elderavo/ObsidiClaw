---
id: 4
title: Multi-Layer Perceptron
type: permanent
tags:
    - neural_networks
    - machine_learning
    - deep_learning
    - activation_functions
    - feedforward
    - perceptron
    - multilayer
    - fully_connected
workspace: vaultus-sapiens
---
# Multi-Layer Perceptron

Multi-Layer Perceptron (MLP) is a generic term for a fully connected Neural Network composed of stacked linear layers (matrix multiplications, usually with bias), with a nonlinear activation function applied between them. It's generally considered the base-case 'vanilla' AI model.

An MLP is often described in terms of input, hidden, and output layers - they are called 'hidden' because they are not readable as output of the machine.

### Processing:
- each linear layer maps one vector space to another
- the activation is applied element-wise after the linear transformation

### Special Case: Equivalence to Linear Transformation
A stack of linear layers with no nonlinear activation between them is equivalent in expressiveness to a single linear transformation. In other words, multiple matrix multiplications with no activation can always be collapsed into one matrix multiplication.

The activation function is crucial: it must be nonlinear in order for depth to matter. With nonlinear activations between layers, an MLP can represent far more complex functions than any single matrix multiply.

In theory, sufficiently large MLPs with nonlinear activations can approximate ANY function given enough width, depth, and appropriate parameters. If it's expressible as a function, it's programmable as a MLP.

## Key Intuition

- **Linear layer**: mixes and reweights information
- **Activation**: introduces nonlinearity
- **Depth**: composes multiple nonlinear transformations into increasingly expressive functions

Without the activation, depth adds no expressive power. With it, depth becomes meaningful.

