import { workerData, parentPort} from 'node:worker_threads';
import { SynclineWorker} from './syncline.js';

const worker = await SynclineWorker.spawn( workerData, parentPort);
if( worker)
	await worker.run();
