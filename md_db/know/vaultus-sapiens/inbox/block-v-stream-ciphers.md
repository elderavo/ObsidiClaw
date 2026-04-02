---
id: 202604011409
type: permanent
tags:
    - ciphers
    - stream_ciphers
    - encryption
    - cryptography
    - security
workspace: vaultus-sapiens
---
# Block v. Stream Ciphers

### Block Ciphers vs Stream Ciphers

**Block ciphers** are cryptographic primitives that generate *pseudo‑random permutations* over fixed‑size blocks (typically 128 bits). They were invented first, widely standardized (DES → AES), and are embedded in hardware accelerators everywhere. Because of this, they serve as the foundation for many constructions: encryption, MACs, hashing schemes, key derivation functions, etc.

**Stream ciphers**, by contrast, are *pseudo‑random generators* that produce a continuous keystream. They encrypt data byte‑by‑byte (or bit‑by‑bit) by XORing plaintext with this keystream. Stream ciphers tend to be faster and conceptually simpler, but they are less general‑purpose and harder to repurpose in other cryptographic contexts.

Block ciphers operate on discrete *blocks* (e.g. 16 bytes for AES), while stream ciphers operate continuously on data streams. In practice, many modern systems use block ciphers in **streaming modes** like CTR or GCM because those modes combine the desirable streaming behavior with the maturity and hardware support of block designs.
