import ASSERT from 'node:assert/strict';
import TEST from 'node:test';
import { Syncline} from '@arcticnotes/syncline';

TEST( 'smoke test', async() => {
	const syncline = await Syncline.spawn( 'stdbuf', [ '-oL', 'tr', 'a-z', 'A-Z']);
	ASSERT.equal( syncline.exchange( 'Hello, world!'), 'HELLO, WORLD!'); 
	await syncline.close();
});
