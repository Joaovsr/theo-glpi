import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { conversations: {} };
  }
  if (!data.conversations || typeof data.conversations !== 'object' || Array.isArray(data.conversations)) {
    throw new Error('Estado local inválido; preserve o arquivo para revisão.');
  }
  data.conversations = Object.assign(Object.create(null), data.conversations);
  return {
    data,
    save() {
      // shortcut: arquivo para um único processo local; usar armazenamento compartilhado antes de múltiplas instâncias.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}
