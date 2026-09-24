import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  // TenancyModule.register({ database }) is not imported here yet: no real
  // DatabaseHandle exists until HU-E1-04 (design.md: "DB in AppModule").
  // Mounting CLS globally now lets the tenant guard set request-scoped
  // context as soon as a route uses it.
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } }), HealthModule],
})
export class AppModule {}
