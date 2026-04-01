---
type: concept
---
# ImageBind: One Embedding Space To Bind Them All
> [!info] Metadata
> **Authors**: Rohit Girdhar, Alaaeldin El-Nouby, Zhuang Liu, Mannat Singh, Kalyan Vasudev Alwala, Armand Joulin, Ishan Misra
> **Year**:
> **Citation Key**: girdharImageBindOneEmbedding2023
> **DOI**: 10.48550/arXiv.2305.05665
> **URL**: http://arxiv.org/abs/2305.05665
>
> **Tags**: #Computer Science - Artificial Intelligence, #Computer Science - Machine Learning, #Computer Science - Computer Vision and Pattern Recognition, #Computer Science - Multimedia
>
> [Full Text PDF](zotero://select/library/items/2IGYFBKJ)


## Abstract
We present ImageBind, an approach to learn a joint embedding across six different modalities - images, text, audio, depth, thermal, and IMU data. We show that all combinations of paired data are not necessary to train such a joint embedding, and only image-paired data is sufficient to bind the modalities together. ImageBind can leverage recent large scale vision-language models, and extends their zero-shot capabilities to new modalities just by using their natural pairing with images. It enables novel emergent applications 'out-of-the-box' including cross-modal retrieval, composing modalities with arithmetic, cross-modal detection and generation. The emergent capabilities improve with the strength of the image encoder and we set a new state-of-the-art on emergent zero-shot recognition tasks across modalities, outperforming specialist supervised models. Finally, we show strong few-shot recognition results outperforming prior work, and that ImageBind serves as a new way to evaluate vision models for visual and non-visual tasks.


## Annotations
### Page 7- Highlight
> <mark class="yellow">The central idea in IMAGEBIND is aligning the embeddings of all modalities to image embeddings. Thus, the image embeddings plays a central role in the emergent alignment of unseen modalities and we study their effect on the emergent zero-shot performance.</mark>

