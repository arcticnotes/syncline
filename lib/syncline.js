import CP from 'node:child_process';
import EventEmitter from 'node:events';
import PATH from 'node:path';
import { Worker} from 'node:worker_threads';

const FILENAME_WORKER = 'worker.js';
const TIMEOUT_WORKER_INIT = 3000; // initialization timeout, in milliseconds
const TIMEOUT_WORKER_TERM = 3000; // termination timeout, in milliseconds
const TIMEOUT_EXCHANGE = 3000; // default timeout, can be overridden for each exchange
const WORKER_PARK = 100; // worker thread sleep unit in idle state, in milliseconds

// Buffer Layout
// -------------
//
// One big SharedArrayBuffer is used to synchronize and transfer data between the main thread and the worker thread.
// Since only one of the two parties "owns" the shared buffer at any given time (see the state machine below), the
// owning party can manipulate the DATA region and the LENGTH field however it wants, but always ends with an
// `Atomics.store()` and an `Atomics.notify()` on the STATE field, while the other party (potentially sleeping on the
// STATE field with an `Atomics.wait()`, in which case, it is woken up by the `Atomics.notify()`) tries to take over the
// ownership with `Atomics.load()` on the STATE field and find out it belonging to that party now.
//
// Taking over:
//
// *  if Atomics.load(STATE) not my-state (optional)
//    *  Atomics.wait(STATE) (optional)
// *  if Atomics.load(STATE) is my-state
//    *  read LENGTH
//    *  read DATA[0:LENGTH]
//
// Giving away:
//
// *  write DATA, record the length written
// *  write LENGTH
// *  Atomics.store(STATE, peer's-state)
// *  Atomics.notify(STATE)
//
// .-------------------------------------------------------------- INDEX_STATE (in 32-bit words)
// |       .------------------------------------------------------ INDEX_LENGTH (in 32-bit words)
// |       .       .---------------------------------------------- INDEX_TIMEOUT (in 32-bit words)
// |       |       |       .-------------------------------------- COUNT_CONTROL (in 32-bit words)
// v       v       v       v                         
// +-------+-------+-------+                         
// |STATE  |LENGTH |TIMEOUT| <------------------------------------ Control View: Int32Array
// +-------+-------+-------+                         
// :                       :                         
// :                       +-+-+-+-+-+-+-+-+-+-+-/.../-+-+-+-+
// :                       | | | | | | | | | | | /.../ | | | | <-- Data View: Uint8Array
// :                       +-+-+-+-+-+-+-+-+-+-+-/.../-+-+-+-+
// :                       :                                 :
// +-----------------------+---------------------/.../-------+
// |CONTROL                |DATA                             | <-- Shared Buffer: SharedArrayBuffer
// +-----------------------+---------------------/.../-------+
// ^                       ^                                 :
// |                       '-------------------------------------- OFFSET_DATA (in bytes)
// '-------------------------------------------------------------- OFFSET_CONTROL (in bytes)
// :                       :<------------------------------->: <-- LENGTH_DATA (in bytes)
// :<------------------------------------------------------->: <-- LENGTH_BUFFER (in bytes)

const INDEX_STATE    = 0; // in 32-bit words
const INDEX_LENGTH   = 1; // in 32-bit words
const INDEX_TIMEOUT  = 2; // in 32-bit words
const COUNT_CONTROL  = 3; // in 32-bit words
const OFFSET_CONTROL = 0; // in bytes
const OFFSET_DATA    = COUNT_CONTROL * Int32Array.BYTES_PER_ELEMENT; // in bytes
const LENGTH_BUFFER  = 4096; // in bytes
const LENGTH_DATA    = LENGTH_BUFFER - OFFSET_DATA; // in bytes

// State Machine
// -------------
//
//                        initiate termination +-------------------+
// .-------------------------------------------|               (M) |
// |                                           |       READY       |<---------------------------. (if the output cannot
// |    .------------------------------------->|  (Initial State)  |                            | be processed, it is
// |    |                                      +-------------------+                            | thrown from the main
// |    |                                             |     |                                   | thread without
// |    |                            start long input |     | short input                       | touching the state
// |    |              .------------------------------'     '------------------------------.    | machine)
// |    |              |                                                                   |    |
// |    |              v           worker                                                  v    | short output
// |    |    +-------------------+ accepted    +-------------------+ input       +-------------------+
// |    |    |               (W) |------------>|               (M) | complete    |               (W) |
// |    |    | INPUT_INCOMPLETE  |             |   INPUT_DRAINED   |------------>|  INPUT_COMPLETE   |
// |    |    |                   |<------------|                   |             |                   |
// |    |    +-------------------+  more input +-------------------+             +-------------------+
// |    |              ^    |            still           | main thread                |    ^    |
// |    |              |    |       incomplete           | canceled            cannot |    |    | start long output
// |    |              |    | cannot                     v                    process |    |    |
// |    |              |    | process          +-------------------+                  |    |    |
// |    |              |    |                  |               (W) |                  |    |    |
// |    |              |    |                  |     CANCELED      |<-----------------|----|----|---------.
// |    |              |    |                  |                   |                  |    |    |         |
// |    |              |    |                  +-------------------+                  |    |    |         |
// |    |              |    |                            | cancel/error               |    |    |         |
// |    |              |    |                            | acknowledged               |    |    |         |
// |    |              |    `-----------------------.    |    .-----------------------'    |    |         |
// |    |              |                            |    |    |                            |    |         |
// |    |              |                            v    v    v                            |    |         |
// |    |              |      start long input +-------------------+ a short input         |    |         |
// |    |              '-----------------------|               (M) |-----------------------'    |         |
// |    |                                      |       ERROR       |                            |         |
// |    |    .---------------------------------|                   |                            |         |
// |    |    |            initiate termination +-------------------+                            |         |
// |    |    |                                           ^                                      |         |
// |    |    |                                           | worker cannot                        |         |
// |    |    |                                           | proceed        worker                v         |
// |    |    |                          output +-------------------+    accepted +-------------------+    |
// |    |    |                       completed |               (W) |<------------|               (M) |    |
// |    '----|---------------------------------|  OUTPUT_DRAINED   |             | OUTPUT_INCOMPLETE |----'
// |         |       (if the last chunk cannot |                   |------------>|                   | canceled or
// |         |      be processed, it is thrown +-------------------+ more output +-------------------+ cannot process
// |         |    from the main thread without                       uncompleted
// |         |     touching the state machine)
// |         |                                 +-------------------+
// |         '-------------------------------->|               ( ) |
// |                                           |    TERMINATING    |                  (M) = Main's turn
// '------------------------------------------>|                   |                  (W) = Worker's turn
//                                             +-------------------+                  ( ) = Dead state

const STATE_READY             = 0; // must be 0, as initialized in SharedArrayBuffer
const STATE_INPUT_INCOMPLETE  = 1;
const STATE_INPUT_DRAINED     = 2;
const STATE_INPUT_COMPLETE    = 3;
const STATE_CANCELED          = 4;
const STATE_ERROR             = 5;
const STATE_OUTPUT_INCOMPLETE = 6;
const STATE_OUTPUT_DRAINED    = 7;
const STATE_TERMINATING       = 8;

const MESSAGE_READY  = 'ready'; // sent if worker is initialized and ready to work
const MESSAGE_ERROR  = 'error'; // sent if worker has an error and cannot work further
const MESSAGE_EXIT   = 'exit'; // when the worker terminated gracefully
const MESSAGE_STDOUT = 'stdout'; // when an unexpected line is received on standard output
const MESSAGE_STDERR = 'stderr'; // when a line is received on the standard error

const LF = Buffer.from( [ 0x0A]);

const EVENT_STDOUT = 'stdout';
const EVENT_STDERR = 'stderr';
const EVENT_EXIT   = 'exit';

export class Syncline extends EventEmitter {

	/**
	 * Spawns a child process with the specified command name and arguments, and returns a {@link Promise} that resolves
	 * to a {@link Syncline}.
	 *
	 * @param { string} command Command name
	 * @param { undefined | string[]} args Arguments, defaults to empty array
	 * @param { undefined | { cwd?: string, env?: { [ key: string]: string}, argv0?: string}} options See the `spawn()`
	 *    function from `child_process` Node.js module. Only `cwd`, `env`, and `argv0` are supported.
	 * @returns { Promise< Syncline>}
	 */
	static async spawn( command, args = [], options = {}) {
		// the initial feedback (whether the worker has successfully spawned the child process and whether it is ready to
		// receive input) must be done through parentPort and not through SharedArrayBuffer+Atomics, because the main
		// thread needs at least one more event loop iteration to set up the worker thread properly. If it starts waiting
		// on Atomics too soon, the worker thread will never be initialized, which will result in a timeout.

		const syncline = new Syncline();
		syncline.#shared = new SharedArrayBuffer( LENGTH_BUFFER);
		syncline.#control = new Int32Array( syncline.#shared, OFFSET_CONTROL, COUNT_CONTROL);
		syncline.#data = new Uint8Array( syncline.#shared, OFFSET_DATA, LENGTH_DATA);
		syncline.#worker = new Worker( PATH.join( import.meta.dirname, FILENAME_WORKER), {
			workerData: { command, args, options, shared: syncline.#shared},
		});
		syncline.once( EVENT_EXIT, codeOrSignal => syncline.#terminated = codeOrSignal);
		await new Promise( ( resolveInit, rejectInit) => {
			const initTimeout = setTimeout(
					() => rejectInit( new Error( `worker initialization timeout (${ TIMEOUT_WORKER_INIT}ms)`)),
					TIMEOUT_WORKER_INIT);
			syncline.#worker.on( 'message', ( [ type, ...parameters]) => {
				switch( type) {
					case MESSAGE_READY:
						resolveInit();
						clearTimeout( initTimeout);
						break;
					case MESSAGE_ERROR:
						if( !syncline.#error)
							syncline.#error = parameters[ 0];
						rejectInit( parameters[ 0]); // no effect if resolveInit() is arleady called
						clearTimeout( initTimeout);
						break;
					case MESSAGE_EXIT:
						syncline.emit( EVENT_EXIT, parameters[ 0] || {});
						break;
					case MESSAGE_STDOUT:
						syncline.emit( EVENT_STDOUT, parameters[ 0]);
						break;
					case MESSAGE_STDERR:
						syncline.emit( EVENT_STDERR, parameters[ 0]);
						break;
					default:
						throw new Error( `undefined message type: ${ type}`); // bug, cuz all messages are sent by us
				}
			});
		});
		return syncline;
	}

	#shared;
	#control;
	#data;
	#worker;
	#error;
	#terminated = false; // false | { code: number} | { signal: string}

	exchange( inputLine, timeout = TIMEOUT_EXCHANGE) {
		const startingState = Atomics.load( this.#control, INDEX_STATE);
		if( startingState !== STATE_READY && startingState !== STATE_ERROR)
			throw new Error( `unexpected state: ${ startingState}`); // bug

		// step 1. send input
		input: for( let remaining = inputLine;;) {
			const { read, written} = new TextEncoder().encodeInto( remaining, this.#data);
			this.#control[ INDEX_LENGTH] = written;
			remaining = remaining.substring( read);
			if( !remaining) {
				this.#control[ INDEX_TIMEOUT] = Math.max( 0, timeout);
				Atomics.store( this.#control, INDEX_STATE, STATE_INPUT_COMPLETE);
				Atomics.notify( this.#control, INDEX_STATE, 1);
				break input;
			}
			Atomics.store( this.#control, INDEX_STATE, STATE_INPUT_INCOMPLETE);
			Atomics.notify( this.#control, INDEX_STATE, 1);
			Atomics.wait( this.#control, INDEX_STATE, STATE_INPUT_INCOMPLETE);
			const inputState = Atomics.load( this.#control, INDEX_STATE);
			switch( inputState) {
				case STATE_INPUT_DRAINED:
					break;
				case STATE_ERROR:
					throw new Error( new TextDecoder( 'utf-8').decode( this.#data.slice( 0, this.#control[ INDEX_LENGTH])));
				default:
					throw new Error( `unexpected worker state: ${ inputState}`); // bug
			}
		}

		// step 2. receive output
		Atomics.wait( this.#control, INDEX_STATE, STATE_INPUT_COMPLETE);
		const buffer = []; // Buffer[]
		output: while( true) {
			const outputState = Atomics.load( this.#control, INDEX_STATE);
			switch( outputState) {
				case STATE_OUTPUT_INCOMPLETE:
					buffer.push( Buffer.from( this.#shared, OFFSET_DATA, this.#control[ INDEX_LENGTH]));
					Atomics.store( this.#control, INDEX_STATE, STATE_OUTPUT_DRAINED);
					Atomics.notify( this.#control, INDEX_STATE, 1);
					Atomics.wait( this.#control, INDEX_STATE, STATE_OUTPUT_DRAINED);
					continue output;
				case STATE_READY: // output-complete
					buffer.push( Buffer.from( this.#shared, OFFSET_DATA, this.#control[ INDEX_LENGTH]));
					return Buffer.concat( buffer).toString( 'utf-8');
				case STATE_ERROR:
					throw new Error( new TextDecoder( 'utf-8').decode( this.#data.slice( 0, this.#control[ INDEX_LENGTH])));
				default:
					throw new Error( `unexpected worker state: ${ outputState}`); // bug
			}
		}
	}

	/**
	 * Terminates the child process, if not already, and returns a {@link Promise} that resolves to one of the following:
	 *
	 * *  An object with property `code` set to the exit status code of the child process.
	 * *  An object with property `signal` set to the signal that terminated the child process.
	 *
	 * @returns { Promise< { code: number} | { signal: string}>}
	 */
	async close() {
		if( this.#terminated)
			return this.#terminated;
		return await new Promise( ( resolveTermination, rejectTermination) => {
			const terminationTimeout = setTimeout(
					() => rejectTermination( new Error( `worker termination timeout (${ TIMEOUT_WORKER_TERM}ms)`)),
					TIMEOUT_WORKER_TERM);
			this.once( EVENT_EXIT, codeOrSignal => {
				resolveTermination( codeOrSignal);
				clearTimeout( terminationTimeout);
			});
			const state = Atomics.load( this.#control, INDEX_STATE);
			switch( state) {
				case STATE_TERMINATING:
					break; // termination initiated by another call? just wait
				case STATE_READY:
				case STATE_ERROR:
					Atomics.store( this.#control, INDEX_STATE, STATE_TERMINATING);
					Atomics.notify( this.#control, INDEX_STATE, 1);
					break;
				default:
					throw new Error( `illegal state: ${ state}`); // bug, cuz all other states are shielded by wait()
			}
		});
	}
}

export class SynclineWorker {

	static async spawn( workerData, parentPort) {
		const worker = new SynclineWorker();
		worker.#shared = workerData.shared;
		worker.#control = new Int32Array( worker.#shared, OFFSET_CONTROL, COUNT_CONTROL);
		worker.#data = new Uint8Array( worker.#shared, OFFSET_DATA, LENGTH_DATA);
		worker.#parentPort = parentPort;

		try {
			const command = workerData.command;
			const args = workerData.args;
			const options = {
				cwd: ( workerData.options || {}).cwd,
				env: ( workerData.options || {}).env,
				argv0: ( workerData.options || {}).argv0,
			};
			const child = CP.spawn( command, args, options);
			worker.#stdin = child.stdin;
			child.stdout.on( 'error', worker.#setError.bind( worker));
			child.stderr.on( 'error', worker.#setError.bind( worker));
			child.stdout.on( 'data', worker.#ingestStdout.bind( worker));
			child.stderr.on( 'data', worker.#ingestStderr.bind( worker));
			child.on( 'close', ( code, signal) => parentPort.postMessage( [ MESSAGE_EXIT, { code, signal}]));
			await new Promise( ( resolveSpawn, rejectSpawn) => {
				child.once( 'error', rejectSpawn);
				child.once( 'spawn', resolveSpawn);
			});
			worker.#parentPort.postMessage( [ MESSAGE_READY]);
			return worker;
		} catch( error) {
			parentPort.postMessage( [ MESSAGE_ERROR, error]);
			return undefined;
		}
	}

	#shared;
	#control;
	#data;
	#parentPort;
	#errorMessage = undefined; // undefined | string, once set, nothing ever succeeds
	#stdoutBuffer = [];
	#stderrBuffer = [];
	#dropLine = 0; // lines to drop, perhaps because timed out and already returned
	#oneTimeConsumer = undefined; // undefined | { resolve: string => void, reject: Error => void}
	#stdin;

	#setError( error) {
		if( this.#errorMessage === undefined)
			try {
				this.#errorMessage = `${ error && error.message}`;
			} catch( error2) {
				this.#errorMessage = 'ERROR';
			} finally {
				this.#parentPort.postMessage( [ MESSAGE_ERROR, this.#errorMessage]);
			}
	}

	#ingestStdout( chunk) {
		if( this.#errorMessage !== undefined)
			return; // once an error occurs, all stdout/stderr data is dropped
		let remaining = chunk;
		for( let indexLF; ( indexLF = remaining.indexOf( 0x0A)) >= 0;) {
			if( indexLF)
				this.#stdoutBuffer.push( remaining.slice( 0, indexLF));
			remaining = remaining.slice( indexLF + 1);
			let decodedLine = undefined;
			let decoderError = undefined;
			try {
				decodedLine = Buffer.concat( this.#stdoutBuffer).toString( 'utf-8');
			} catch( error) {
				decoderError = error || new Error( `decoder error`);
			}
			this.#stdoutBuffer.length = 0;
			if( this.#dropLine)
				this.#dropLine--;
			else if( this.#oneTimeConsumer) {
				if( decoderError) {
					this.#oneTimeConsumer.reject( decoderError)
					this.#setError( decoderError);
					return; // once an error occurs, all stdout/stderr data is dropped
				} else
					this.#oneTimeConsumer.resolve( decodedLine);
				this.#oneTimeConsumer = undefined;
			} else
				if( decoderError) {
					this.#setError( error);
					return; // once an error occurs, all stdout/stderr data is dropped
				} else
					this.#parentPort.postMessage( [ MESSAGE_STDOUT, decodedLine]);
		}
		if( remaining.length)
			this.#stdoutBuffer.push( remaining);
	}

	#ingestStderr( chunk) {
		if( this.#errorMessage !== undefined)
			return; // once an error occurs, all stdout/stderr data is dropped
		try {
			let remaining = chunk;
			for( let indexLF; ( indexLF = remaining.indexOf( 0x0A)) >= 0;) {
				if( indexLF)
					this.#stderrBuffer.push( remaining.slice( 0, indexLF));
				remaining = remaining.slice( indexLF + 1);
				const line = Buffer.concat( this.#stderrBuffer).toString( 'utf-8');
				this.#stderrBuffer.length = 0;
				this.#parentPort.postMessage( [ MESSAGE_STDERR, line]);
			}
			if( remaining.length)
				this.#stderrBuffer.push( remaining);
		} catch( error) {
			this.#setError( error);
			return; // once an error occurs, all stdout/stderr data is dropped
		}
	}

	async run() {
		for( let state; ( state = Atomics.load( this.#control, INDEX_STATE)) !== STATE_TERMINATING;)
			switch( state) {
				case STATE_READY:
				case STATE_ERROR:
					await new Promise( resolve => setImmediate( resolve)); // yield the thread for IO
					Atomics.wait( this.#control, INDEX_STATE, state, WORKER_PARK); // rate limit
					break;
				case STATE_INPUT_INCOMPLETE:
					await this.#handleInputIncomplete();
					break;
				case STATE_INPUT_COMPLETE:
					await this.#handleInputComplete();
					break;
				default:
					this.#setError( new Error( `unexpected worker state: ${ state}`)); // bug
			}
		this.#stdin.end();
	}

	async #handleInputIncomplete() {
		if( this.#errorMessage !== undefined) {
			this.#control[ INDEX_LENGTH] = new TextEncoder().encodeInto( this.#errorMessage, this.#data).written;
			Atomics.store( this.#control, INDEX_STATE, STATE_ERROR);
			Atomics.notify( this.#control, INDEX_STATE, 1);
			return;
		}

		this.#stdin.write( Buffer.from( this.#shared, OFFSET_DATA, this.#control[ INDEX_LENGTH]));
		await new Promise( resolve => setImmediate( resolve)); // not necessary, but allows detecting IO errors earlier
		Atomics.store( this.#control, INDEX_STATE, STATE_INPUT_DRAINED);
		Atomics.notify( this.#control, INDEX_STATE, 1);
		Atomics.wait( this.#control, INDEX_STATE, STATE_INPUT_DRAINED); // wait indefinitely, trust the main thread
	}

	async #handleInputComplete() {
		if( this.#errorMessage !== undefined) {
			this.#control[ INDEX_LENGTH] = new TextEncoder().encodeInto( this.#errorMessage, this.#data).written;
			Atomics.store( this.#control, INDEX_STATE, STATE_ERROR);
			Atomics.notify( this.#control, INDEX_STATE, 1);
			return;
		}

		this.#stdin.write( Buffer.from( this.#shared, OFFSET_DATA, this.#control[ INDEX_LENGTH]));
		this.#stdin.write( LF);
		let outputLine = undefined;
		let errorMessage = undefined;
		try {
			outputLine = await new Promise( ( resolve, reject) => {
				const timeout = setTimeout( () => {
					const error = new Error( `invocation timeout: ${ this.#control[ INDEX_TIMEOUT]}ms`);
					if( this.#oneTimeConsumer) { // this should always be true, because when unset, timer also cleared
						this.#oneTimeConsumer = undefined;
						this.#dropLine++;
					}
					// do not call this.#setError( error), because this error is limited to this one call
					reject( error);
				}, this.#control[ INDEX_TIMEOUT]);
				this.#oneTimeConsumer = {
					resolve( line) {
						resolve( line);
						clearTimeout( timeout);
					},
					reject( error) {
						reject( error);
						clearTimeout( timeout);
					},
				};
			});
		} catch( error) {
			try {
				errorMessage = `${ error && error.message}` || 'ERROR';
			} catch( error2) {
				errorMessage = 'ERROR';
			}
		}

		if( errorMessage !== undefined) {
			this.#control[ INDEX_LENGTH] = new TextEncoder().encodeInto( errorMessage, this.#data).written;
			Atomics.store( this.#control, INDEX_STATE, STATE_ERROR);
			Atomics.notify( this.#control, INDEX_STATE, 1);
			return;
		}

		output: for( let remaining = outputLine;;) {
			const { read, written} = new TextEncoder().encodeInto( remaining, this.#data);
			this.#control[ INDEX_LENGTH] = written;
			remaining = remaining.substring( read);
			if( !remaining) {
				Atomics.store( this.#control, INDEX_STATE, STATE_READY);
				Atomics.notify( this.#control, INDEX_STATE, 1);
				break output;
			}
			Atomics.store( this.#control, INDEX_STATE, STATE_OUTPUT_INCOMPLETE);
			Atomics.notify( this.#control, INDEX_STATE, 1);
			Atomics.wait( this.#control, INDEX_STATE, STATE_OUTPUT_INCOMPLETE);
			const state = Atomics.load( this.#control, INDEX_STATE);
			switch( state) {
				case STATE_CANCELED:
					Atomics.store( this.#control, INDEX_STATE, STATE_ERROR);
					Atomics.notify( this.#control, INDEX_STATE, 1);
					break output;
				case STATE_OUTPUT_DRAINED:
					continue output;
				default:
					this.#setError( new Error( `unexpected worker state: ${ state}`)); // bug
			}
		}
	}
}
