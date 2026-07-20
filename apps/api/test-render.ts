import { ReceiptService } from './src/banking/receipt.service';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const svc = new ReceiptService();

const png = svc.render({
  status: 'COMPLETED',
  currency: 'NGN',
  amount: 15000,
  sender: 'DAVID UZOCHUKWU',
  recipient: 'JOHN DOE',
  bank: 'Access Bank',
  account: '1229613501',
  reference: 'ABCD1234',
  providerRef: 'TRF927769939037580653864',
  providerId: '1000332607021301200201673',
  feeNote: 'Fee covered by your 30 free transfers/month',
  date: new Date(),
});

const outPath = '/Users/user/.gemini/antigravity-ide/brain/15ffdd6a-f470-4f34-93f6-cc4195c389e9/scratch/sample-receipt.png';
writeFileSync(outPath, png);
console.log(`PNG generated at ${outPath}`);
