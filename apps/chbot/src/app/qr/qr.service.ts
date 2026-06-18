import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as QRCode from 'qrcode';

@Injectable()
export class QrCodeService {
  async generateQrBuffer(text: string): Promise<Buffer> {
    try {
      return await QRCode.toBuffer(text, {
        type: 'png',
        errorCorrectionLevel: 'H',
        margin: 4,
        scale: 4,
      });
    } catch (error) {
      throw new InternalServerErrorException('Failed to generate QR code');
    }
  }
}
