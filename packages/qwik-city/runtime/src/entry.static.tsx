import { qwikCityGenerate } from '../../static/node';
import render from './entry.ssr';
import { fileURLToPath } from 'url';
import { join } from 'path';

// Execute Qwik City Static Generator
qwikCityGenerate(render, {
  baseUrl: 'https://qwik.builder.io/',
  outDir: join(fileURLToPath(import.meta.url), '..', '..', 'dist'),
  log: 'debug',
});
