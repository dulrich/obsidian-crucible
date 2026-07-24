# Crucible Search companion — headless JSON API (SQLite FTS5) for the Obsidian plugin.
# No dependency install: the server imports only Node builtins. node:sqlite is unflagged
# from Node 23.4, so the base image must stay >= 24.
FROM node:24-slim
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app
COPY scripts/search-companion.mjs ./scripts/search-companion.mjs
ENV CRUCIBLE_SEARCH_PORT=4801 \
    CRUCIBLE_SEARCH_HOST=0.0.0.0 \
    CRUCIBLE_SEARCH_DB=/data/search.sqlite
EXPOSE 4801
VOLUME ["/data"]
CMD ["node", "scripts/search-companion.mjs"]
