---
type: permanent
---
I learned about the concept of a neural net operating on input with the mental model of nodes interconnected, and a serial implementation of each node multiplying, adding bias, and processing through the net. 

However, I also know that (1) a neural net with only linear activations is equivalent to a one-layer neural net. (2) a 1-layer neural net is equivalent to a linear regression. (3) a linear regression can be expressed as a matrix multiplication.

Therefore it follows that a 1-layer neural net can be expressed as a matrix multiplication with linear activation.

### 1. How do we express non-linearity in this? 
### 2. What's the actual chaining of matmuls 