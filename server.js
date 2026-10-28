'use strict';
const http = require('node:http');
const config = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp(config);

const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 }, (req, res) => {
  app.handle(req, res);
});
server.maxHeadersCount = 100;

server.listen(config.PORT, config.HOST, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'Ntintan started', url: config.PUBLIC_URL, port: config.PORT, env: config.NODE_ENV, payments: config.PAYMENTS_MODE }));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: `Received ${signal}, shutting down` }));
  server.close(() => { app.close(); process.exit(0); });
  setTimeout(() => { app.close(); process.exit(1); }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', error: String(e?.stack || e) })));
