import { Module, Global } from '@nestjs/common';
import {QrCodeService} from "./qr.service";

@Global()
@Module({
  providers: [QrCodeService],
  exports: [QrCodeService],
})
export class QrModule {}
