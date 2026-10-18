# syntax=docker/dockerfile:1.7
# Supply immutable, same-architecture OCI digests through the build command.
ARG RUST_IMAGE
ARG NODE_IMAGE

FROM ${RUST_IMAGE} AS rdsh-build
WORKDIR /src/rdsh
COPY . .
RUN cargo build --locked --release

FROM ${NODE_IMAGE} AS dsh-build
ARG DSH_REF=dsh-v0.2.1-rc.2
ARG DSH_COMMIT=687f282e8625c6b8d11ff58211a90524be2e4317
WORKDIR /opt
RUN git clone --depth 1 --branch "${DSH_REF}" https://github.com/deepseek-ai/deepseek-harness.git dsh \
    && test "$(git -C dsh rev-parse HEAD)" = "${DSH_COMMIT}" \
    && npm install --global pnpm@11.28.5 \
    && cd dsh \
    && pnpm install --frozen-lockfile \
    && pnpm run build \
    && rm -rf .git

FROM ${NODE_IMAGE}
ARG DSH_COMMIT=687f282e8625c6b8d11ff58211a90524be2e4317
LABEL org.opencontainers.image.source="https://github.com/jimoto-no-llm/rustdsh" \
      org.opencontainers.image.licenses="MIT" \
      cloud.rdsh.dev/dsh-commit="${DSH_COMMIT}"
COPY --from=rdsh-build /src/rdsh/target/release/rdsh /usr/local/bin/rdsh
COPY --from=rdsh-build /src/rdsh/LICENSE /usr/share/licenses/rdsh/LICENSE
COPY --from=rdsh-build /src/rdsh/THIRD_PARTY_NOTICES.md /usr/share/licenses/rdsh/THIRD_PARTY_NOTICES.md
COPY --from=dsh-build /opt/dsh /opt/dsh
RUN mkdir -p /workspace /home/node/.dsh \
    && chown -R node:node /workspace /home/node
ENV HOME=/home/node \
    DSH_HOME=/home/node/.dsh \
    RDSH_ORIG_BIN=/opt/dsh/apps/cli/lib/bin.js
WORKDIR /workspace
USER node
CMD ["sleep", "infinity"]
