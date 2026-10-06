import { NestFactory } from '@nestjs/core';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { createHttpAdapter } from './bootstrap/http.js';
import { parsePort } from './bootstrap/port.js';
import { loadAuthHttpConfig } from './modules/identity/infrastructure/http/auth-http-config.js';

const port = parsePort(process.env.PORT);
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  createHttpAdapter(loadAuthHttpConfig(process.env).trustProxyHops),
);
// Runs each module's onModuleDestroy() (e.g. DatabaseModule closing its pg
// Pool) on SIGTERM/SIGINT, so a restart or `docker stop` doesn't leak
// connections instead of shutting them down cleanly.
app.enableShutdownHooks();
await app.listen(port, '0.0.0.0');
console.log(`@sifen/api listening on port ${String(port)}`);
