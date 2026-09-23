import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
const port = process.env.PORT ?? 3000;
await app.listen(port, '0.0.0.0');
console.log(`@sifen/api listening on port ${String(port)}`);
