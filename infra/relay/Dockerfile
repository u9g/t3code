# The relay as a Node service, for hosts other than Cloudflare. Build the
# bundle first (`vp run --filter t3code-relay build:node`); this directory is
# the build context.
FROM node:24-slim

WORKDIR /app
COPY dist/relay.mjs dist/relay.mjs.map ./dist/
COPY migrations ./migrations

ENV NODE_ENV=production \
    RELAY_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/relay.mjs"]
