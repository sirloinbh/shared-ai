// Makes the Ed25519 key pair shared-ai signs tool calls with. Node built-ins only; run it on the owner's PC.
//   node backend/scripts/signing-key.mjs --public-out <file> | node <project-standards>/tools/app-secrets.mjs set /sirloinbh/shared-ai/tools-signing-key
//   then store <file> at /sirloinbh/shared/ai-tools-public-key the same way, and delete <file>.
// The private key goes only to standard output (piped into SSM); the public key goes to the file. Both are one line
// with `\n` escapes, because SSM values and .env lines are single lines.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const at = process.argv.indexOf('--public-out');
const out = at > 0 ? process.argv[at + 1] : undefined;
if (!out) {
  console.error('usage: node backend/scripts/signing-key.mjs --public-out <file> | <store standard input in SSM>');
  process.exit(2);
}
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(out, oneLine(publicKey.export({ type: 'spki', format: 'pem' }).toString()) + '\n');
process.stdout.write(oneLine(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()));
console.error(`signing-key: public key written to ${out}`);
