# Single long-lived process for the hosted dry-run demo (or a real deployment behind your own auth).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false
COPY . .
RUN npm run build
# Bake the seeded, simulated history so the first request is instant.
RUN SHORTLINE_MODE=dry-run SHORTLINE_DB=/app/data/shortline.sqlite SHORTLINE_FAKE_PACE_MS=0 node --disable-warning=ExperimentalWarning dist/cli.js demo --no-serve
ENV SHORTLINE_MODE=dry-run \
    SHORTLINE_DB=/app/data/shortline.sqlite \
    SHORTLINE_HOST=0.0.0.0 \
    SHORTLINE_PORT=8787 \
    SHORTLINE_FAKE_PACE_MS=1500 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8787
CMD ["node", "dist/cli.js", "demo"]
