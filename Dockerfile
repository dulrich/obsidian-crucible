# Crucible Search companion — headless JSON API (SQLite FTS5) for the Obsidian plugin.
# No dependency install: the server imports only Node builtins. node:sqlite is unflagged
# from Node 23.4, so the base image must stay >= 24.
FROM node:24-slim
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app
# Two COPYs, not one: `search-companion.mjs` is the executable + re-export facade and
# `search-companion/` is the implementation it re-exports (WP-rem-R3 split the former
# single file into that directory). Both are still dependency-free — there is deliberately
# no package.json copy and no install step — so keep new modules inside this directory;
# anything imported from outside it silently breaks this image. The `.dockerignore`
# allowlist carries the matching pair of entries.
COPY scripts/search-companion.mjs ./scripts/search-companion.mjs
COPY scripts/search-companion/ ./scripts/search-companion/
ENV CRUCIBLE_SEARCH_PORT=4801 \
    CRUCIBLE_SEARCH_HOST=0.0.0.0 \
    CRUCIBLE_SEARCH_DB=/data/search.sqlite
EXPOSE 4801
VOLUME ["/data"]
RUN groupadd -g 1001 app && useradd -m -u 1001 -g app app
USER app
CMD ["node", "scripts/search-companion.mjs"]
