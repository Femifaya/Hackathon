import { resolve } from 'node:path';
import { getConfig } from '../src/lib/config/env.ts';
import { ReportStore } from '../src/lib/reports/store.ts';

const store = new ReportStore(resolve(process.cwd(), getConfig().database.path), true);
store.close();
process.stdout.write('Report database is ready.\n');
