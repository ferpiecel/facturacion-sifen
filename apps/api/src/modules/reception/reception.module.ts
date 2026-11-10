import { Module } from '@nestjs/common';
import { ReceivedDocumentsController } from './infrastructure/http/received-documents.controller.js';

/** Reception bounded context (ADR-0019): intake, extraction and review of received documents. */
@Module({ controllers: [ReceivedDocumentsController] })
export class ReceptionModule {}
