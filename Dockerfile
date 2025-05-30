# Base image for building dependencies
FROM node:23.1-bookworm-slim AS build-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    curl \
    postgresql-client \
    git \
    openssh-client \
    build-essential \
    pkg-config \
    libssl-dev \
    ca-certificates \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo --version && rustc --version

# git clone and build manually because npm install is failing. tries to use ssh and fails
RUN git clone https://github.com/SatoshiPortal/payjoin-typescript.git
WORKDIR /payjoin-typescript
RUN npm install --also=dev
# have to install ts separately to resolve linking problems
RUN npm install --save-dev typescript@5.7.3
RUN npx tsc

WORKDIR /payjoin
COPY package.json /payjoin
RUN sed -i 's|"payjoin-ts": ".*"|"payjoin-ts": "file:/payjoin-typescript"|g' package.json
RUN npm install

#--------------------------------------------------------------

# Development image
FROM node:23.1-bookworm-slim AS dev

WORKDIR /payjoin

COPY --from=build-base /payjoin/node_modules/ /payjoin/node_modules/
COPY --from=build-base /payjoin-typescript/ /payjoin-typescript/
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
COPY --from=build-base /payjoin-typescript/ /payjoin-typescript/
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

EXPOSE 8000

CMD ["npm", "run", "start"]