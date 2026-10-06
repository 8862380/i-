FROM node:24-alpine

WORKDIR /app
COPY . /app

ENV PORT=8787
ENV HOST=0.0.0.0
ENV NODE_OPTIONS=--no-warnings

EXPOSE 8787
VOLUME ["/app/realtime/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "realtime/server.js"]
