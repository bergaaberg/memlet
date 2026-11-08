# Dovre's sandbox toolchain: built on dovre-sandbox (Node 24, git, curl), cached until this file changes.
FROM dovre-sandbox
USER root
RUN corepack disable pnpm && npm install -g pnpm && pnpm --version
USER agent
