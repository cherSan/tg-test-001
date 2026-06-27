import { Module } from '@nestjs/common';
import { HideFoxService } from './hidefox.service';

@Module({
  providers: [HideFoxService],
  exports: [HideFoxService],
})
export class HideFoxModule {}
