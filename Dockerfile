# PhoenixAgent: the service, the console and the seven tools.
#
# Node 24 runs the TypeScript sources directly (native type stripping), so there is no build step and no dist
# directory to keep in sync with the code - the same files the tests run are the files the image runs.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh && npm ci --omit=dev --ignore-scripts || true

ENV NODE_ENV=production \
    PAGENT_PORT=8790 \
    PAGENT_WORKSPACE=/data \
    PHOENIXGRAPH_API=http://phoenixgraph:8081

VOLUME ["/data"]
EXPOSE 8790

# the demo warehouse is generated (it is not committed), then the semantic model is built, then the service starts
ENTRYPOINT ["/app/docker/entrypoint.sh"]
