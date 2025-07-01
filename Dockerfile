FROM node:20-alpine

WORKDIR /codebase

COPY package*.json /codebase/
RUN npm ci --production

COPY . /codebase

ENV NODE_ENV production
ENTRYPOINT ["./bin/server.js"]
