# Cloud Swarm third-party notices

The Rust CLI contains no copied Gas City, Gas Town, Beads, Agent Sandbox or
Kueue source. It calls an operator-provided Gas City binary and the Kubernetes
Agent Sandbox API. The optional worker image builds DeepSeek Harness from its
fixed source commit and retains `/opt/dsh/LICENSE` and its upstream
`THIRD_PARTY_NOTICES.md` inside the image.

| Component | Fixed source | License | Distribution in this change |
| --- | --- | --- | --- |
| Gas City | `fec82025d24392176eef9153ebf7af8759c6ef0c` | MIT | External executable only |
| Gas Town | `649b832b7672bc7a2dbef26f5983aba6198b819b` | MIT | None |
| Beads | `4a67d0d0288c1b4ee23e17fc896f47616931ba2d` | MIT | None |
| Agent Sandbox | `e0b002e221a7e8d5534f686fe1d3ef4fdfd6d6bb` | Apache-2.0 | None |
| Kueue | `bb201e17bd1cf47909aad100b0f6aaaa92bd3efd` | Apache-2.0 | None |
| DeepSeek Harness | `687f282e8625c6b8d11ff58211a90524be2e4317` | MIT | Optional worker image |

See [`cloud/upstream-lock.json`](cloud/upstream-lock.json) for repositories and
roles. The source repositories' root LICENSE files were checked at these
commits. This is not a transitive image license audit. Before distributing an
image, retain the generated package notices and a complete SBOM for the exact
image layers and npm/native dependencies. The repository's own license is
[`LICENSE`](LICENSE).
