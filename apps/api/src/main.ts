import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { parsePort } from './bootstrap/port.js';

const port = parsePort(process.env.PORT);
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.listen(port, '0.0.0.0');
console.log(`@sifen/api listening on port ${String(port)}`);
