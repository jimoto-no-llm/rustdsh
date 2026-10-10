# Cross-project overview evidence

The PNGs compare the existing project dashboard with the opt-in cross-project
summary enabled. They are captured by `tests/e2e/project-overview.mjs` using
synthetic `primary`, `included`, and `not-included` fixtures.

The browser check confirms that only the explicitly included project appears,
the summary link does not carry its browser credential, and the page fits a
390 px viewport without horizontal overflow. No provider, model, or user
project data is used.
