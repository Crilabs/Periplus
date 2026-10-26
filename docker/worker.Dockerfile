# Production image for the pg-boss worker and one-off scripts (migrate). Chromium comes with the base image.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
# pdftotext (Poppler) extracts PDF text with its layout.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx is a regular dependency; production deps only keeps the image small.
RUN npm ci --omit=dev && npm cache clean --force
# tsconfig.json provides the "@/" path alias that tsx resolves at runtime.
COPY --chown=pwuser:pwuser tsconfig.json ./
COPY --chown=pwuser:pwuser config ./config
# The delivery contract (zod schemas); lib/config and the delivery build import it.
COPY --chown=pwuser:pwuser contract ./contract
COPY --chown=pwuser:pwuser drizzle ./drizzle
COPY --chown=pwuser:pwuser lib ./lib
COPY --chown=pwuser:pwuser worker ./worker
COPY --chown=pwuser:pwuser scripts ./scripts
# Late, so a new sha does not bust the layers above.
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
USER pwuser
CMD ["node", "--import", "tsx", "worker/index.ts"]
