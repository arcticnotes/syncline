import ASSERT from 'node:assert/strict';
import TEST from 'node:test';
import { Syncline} from '@arcticnotes/syncline';

TEST( 'smoke test', async() => {
	const syncline = await Syncline.spawn( 'stdbuf', [ '-oL', 'tr', 'a-z', 'A-Z'], { trace: 3});
	syncline.on( 'input', line => console.log( `input (length=${ line.length}):`, line));
	syncline.on( 'output', line => console.log( `output (length=${ line.length}):`, line));
	ASSERT.equal( syncline.exchange( 'Hello, world!'), 'HELLO, WORLD!'); 
	await new Promise( resolve => setTimeout( resolve, 500));
	await syncline.close();
});
