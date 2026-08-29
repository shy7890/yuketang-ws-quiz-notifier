import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const metadata = await fs.readFile(path.join(projectRoot, 'src/userscript.meta.js'), 'utf8');
const core = await fs.readFile(path.join(projectRoot, 'src/core.js'), 'utf8');
const app = await fs.readFile(path.join(projectRoot, 'src/app.js'), 'utf8');

const metadataVersion = metadata.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
if (metadataVersion !== packageJson.version) {
  throw new Error(`Version mismatch: package=${packageJson.version}, metadata=${metadataVersion || 'missing'}`);
}

const outputDirectory = path.join(projectRoot, 'dist');
const outputPath = path.join(outputDirectory, 'yuketang-quiz-notifier.user.js');
const output = `${metadata.trim()}\n\n${core.trim()}\n\n${app.trim()}\n`;

await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(outputPath, output, 'utf8');
console.log(`Built ${path.relative(projectRoot, outputPath)} (${Buffer.byteLength(output)} bytes)`);
