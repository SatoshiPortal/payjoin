# Base image for building dependencies
FROM node:23.1-bookworm-slim AS build-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    curl \
    postgresql-client \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /payjoin
COPY package.json package-lock.json /payjoin/
RUN npm ci

#--------------------------------------------------------------

# Development image
FROM node:23.1-bookworm-slim AS dev

WORKDIR /payjoin

COPY --from=build-base /payjoin/node_modules/ /payjoin/node_modules/
COPY package.json /payjoin
COPY tsconfig.json /payjoin
COPY src /payjoin/src

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    curl \
    postgresql-client \
    ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8000

CMD ["npm", "run", "start:dev"]

#--------------------------------------------------------------

# Production image
FROM node:23.1-bookworm-slim AS prod

WORKDIR /payjoin

COPY --from=build-base /payjoin/node_modules/ /payjoin/node_modules/
COPY package.json /payjoin
COPY tsconfig.json /payjoin
COPY src /payjoin/src

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    curl \
    postgresql-client \
    ca-certificates \
    python3 \
    python-is-python3 \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npx prisma generate
RUN npm run build

COPY scripts /payjoin/scripts
RUN chmod +x /payjoin/scripts/entrypoint.sh

EXPOSE 8000

CMD ["/payjoin/scripts/entrypoint.sh"]
