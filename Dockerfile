FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY src ./src
COPY config ./config
COPY scripts/check-classification.mjs ./scripts/check-classification.mjs
COPY scripts/check-intake.mjs ./scripts/check-intake.mjs
COPY test/fixtures/classification.json ./test/fixtures/classification.json
COPY test/fixtures/intake.json ./test/fixtures/intake.json
COPY .m365agentsplayground.yml ./
USER node
CMD ["node", "src/index.mjs"]
