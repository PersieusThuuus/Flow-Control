import fs from 'node:fs';
import path from 'node:path';

const srcStatic = path.join('.next', 'static');
const destStatic = path.join('.next', 'standalone', '.next', 'static');
const srcPublic = 'public';
const destPublic = path.join('.next', 'standalone', 'public');

try {
  if (fs.existsSync(srcStatic)) {
    fs.cpSync(srcStatic, destStatic, { recursive: true });
  }
  if (fs.existsSync(srcPublic)) {
    fs.cpSync(srcPublic, destPublic, { recursive: true });
  }
} catch (err) {
  console.error('Failed to copy standalone assets:', err);
  process.exit(1);
}
